/* index.js - ENHANCED VERSION WITH ARRIVAL TRACKING
 * Telegram Booking Bot using Google Sheets + Google Calendar + Capacity Control + Arrival Tracking
 * ========================================
 */

import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import { Telegraf, Markup } from 'telegraf';
import { GoogleSpreadsheet } from 'google-spreadsheet';
import { JWT } from 'google-auth-library';
import { google } from 'googleapis';
import { readFile } from 'fs/promises';

// ── Configuration from environment variables ────────────────────────────────
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '7938845737:AAHrsANimK_-b_vRV_8Dm3BY1jUo7BcCAY8';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '7226556716';
const CALENDAR_ID = process.env.CALENDAR_ID || 'e26eec24c84a8d03d554eb3e498f37888f208cbc4c8fa741408319b1c1fcb06b@group.calendar.google.com';
const SHEET_ID = process.env.SHEET_ID || '1lXv4lJ6dYUUaIYf44Xx44yx_aKiPfTfzymyCAeflgz0';
const PORT = process.env.PORT || 3000;

// ── CAPACITY MANAGEMENT CONFIGURATION ───────────────────────────────────────
const CAPACITY_CONFIG = {
  lunch: {
    maxCapacity: 60,
    startHour: 12,
    endHour: 14,
    blocked: false  // Blocage spécifique du service
  },
  dinner: {
    maxCapacity: 70,
    startHour: 19,
    endHour: 22,
    blocked: false  // Blocage spécifique du service
  }
};

// État de blocage global des réservations en ligne
let globalOnlineBookingBlocked = false;
let waitingList = new Map(); // Pour stocker les demandes en attente

// NEW: Track if sheet has phone/email columns and arrival tracking
let sheetHasPhoneEmail = false;
let sheetHasArrivalTracking = false;

// Express setup
const app = express();
app.use(bodyParser.json());

// Add CORS middleware for Webflow
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

// Health-check
app.get('/', (req, res) => res.json({ 
  status: 'running', 
  service: 'La Savane Booking Bot with Capacity Management + Arrival Tracking',
  timestamp: new Date().toISOString()
}));

// Telegram bot
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

// Global variables for Google Sheets and Calendar
let doc;
let sheet;
let calendar;
let serviceAccountAuth;

// Store user reservation sessions
const userSessions = new Map();

// ═══════════════════════════════════════════════════════════════════════════
// CAPACITY MANAGEMENT FUNCTIONS - FIXED VERSION WITH PARTYSIZE
// ═══════════════════════════════════════════════════════════════════════════

// Déterminer le service (déjeuner/dîner) selon l'heure
function getServiceType(dateTime) {
  const hour = new Date(dateTime).getHours();
  
  if (hour >= CAPACITY_CONFIG.lunch.startHour && hour <= CAPACITY_CONFIG.lunch.endHour) {
    return 'lunch';
  } else if (hour >= CAPACITY_CONFIG.dinner.startHour && hour <= CAPACITY_CONFIG.dinner.endHour) {
    return 'dinner';
  }
  return null; // Hors heures de service
}

// FIXED: Calculer la capacité utilisée pour un service donné avec PartySize
async function getUsedCapacity(date, serviceType) {
  try {
    if (!sheet) {
      console.log('❌ DEBUG: Sheet not initialized');
      return 0;
    }
    
    await sheet.loadHeaderRow();
    const rows = await sheet.getRows();
    
    const dateStr = date.toISOString().split('T')[0];
    const service = CAPACITY_CONFIG[serviceType];
    
    console.log(`🔍 DEBUG: Looking for ${serviceType} reservations on ${dateStr}`);
    console.log(`🔍 DEBUG: Service hours: ${service.startHour}h-${service.endHour}h`);
    console.log(`🔍 DEBUG: Total rows in sheet: ${rows.length}`);
    
    let totalPeople = 0;
    let matchingReservations = [];
    
    rows.forEach((row, index) => {
      const dateTime = row.get('DateTime');
      const party = row.get('PartySize');
      const name = row.get('Name');
      
      // Debug: afficher quelques lignes pour diagnostiquer
      if (index < 3 || dateTime?.startsWith(dateStr)) {
        console.log(`🔍 DEBUG Row ${index}: DateTime="${dateTime}", PartySize="${party}", Name="${name}"`);
      }
      
      if (dateTime && dateTime.startsWith(dateStr)) {
        const reservationDate = new Date(dateTime);
        const reservationHour = reservationDate.getHours();
        
        console.log(`📅 DEBUG: Found reservation on ${dateStr} at hour ${reservationHour}`);
        
        if (reservationHour >= service.startHour && reservationHour <= service.endHour) {
          const partySize = parseInt(party || 0);
          totalPeople += partySize;
          
          matchingReservations.push({
            name: name,
            time: reservationDate.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
            party: partySize
          });
          
          console.log(`✅ DEBUG: Added ${partySize} people for ${name} at ${reservationDate.toLocaleTimeString()}`);
        } else {
          console.log(`❌ DEBUG: Reservation at ${reservationHour}h is outside ${serviceType} hours (${service.startHour}h-${service.endHour}h)`);
        }
      }
    });
    
    console.log(`📊 DEBUG: Total people for ${serviceType}: ${totalPeople}`);
    console.log(`📊 DEBUG: Matching reservations:`, matchingReservations);
    
    return totalPeople;
  } catch (error) {
    console.error('❌ Erreur calcul capacité:', error);
    return 0;
  }
}

// Vérifier si une réservation est possible
async function checkCapacityAvailable(dateTime, partySize) {
  const serviceType = getServiceType(dateTime);
  if (!serviceType) {
    return { available: false, reason: 'Hors heures de service' };
  }
  
  // Vérifier si le service spécifique est bloqué
  if (CAPACITY_CONFIG[serviceType].blocked) {
    return { 
      available: false, 
      reason: 'Service temporairement fermé',
      service: serviceType === 'lunch' ? 'déjeuner' : 'dîner'
    };
  }
  
  const date = new Date(dateTime);
  const usedCapacity = await getUsedCapacity(date, serviceType);
  const maxCapacity = CAPACITY_CONFIG[serviceType].maxCapacity;
  const remainingCapacity = maxCapacity - usedCapacity;
  
  if (partySize <= remainingCapacity) {
    return { 
      available: true, 
      remaining: remainingCapacity - partySize,
      service: serviceType === 'lunch' ? 'déjeuner' : 'dîner'
    };
  } else {
    return { 
      available: false, 
      reason: 'Capacité insuffisante',
      remaining: remainingCapacity,
      needed: partySize,
      service: serviceType === 'lunch' ? 'déjeuner' : 'dîner'
    };
  }
}

// Obtenir le statut de capacité pour aujourd'hui
async function getTodayCapacityStatus() {
  const today = new Date();
  
  const lunchUsed = await getUsedCapacity(today, 'lunch');
  const dinnerUsed = await getUsedCapacity(today, 'dinner');
  
  return {
    lunch: {
      used: lunchUsed,
      max: CAPACITY_CONFIG.lunch.maxCapacity,
      remaining: CAPACITY_CONFIG.lunch.maxCapacity - lunchUsed,
      percentage: Math.round((lunchUsed / CAPACITY_CONFIG.lunch.maxCapacity) * 100),
      blocked: CAPACITY_CONFIG.lunch.blocked
    },
    dinner: {
      used: dinnerUsed,
      max: CAPACITY_CONFIG.dinner.maxCapacity,
      remaining: CAPACITY_CONFIG.dinner.maxCapacity - dinnerUsed,
      percentage: Math.round((dinnerUsed / CAPACITY_CONFIG.dinner.maxCapacity) * 100),
      blocked: CAPACITY_CONFIG.dinner.blocked
    }
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// ARRIVAL TRACKING FUNCTIONS - NEW FEATURE
// ═══════════════════════════════════════════════════════════════════════════

// Get today's reservations by service with arrival status
async function getTodayReservationsByService(serviceType) {
  try {
    if (!sheet) {
      throw new Error('Sheet not initialized');
    }
    
    await sheet.loadHeaderRow();
    const rows = await sheet.getRows();
    
    const today = getTodayString();
    const service = CAPACITY_CONFIG[serviceType];
    
    const reservations = [];
    
    rows.forEach((row, index) => {
      const dateTime = row.get('DateTime');
      
      if (dateTime && dateTime.startsWith(today)) {
        const reservationDate = new Date(dateTime);
        const reservationHour = reservationDate.getHours();
        
        // Check if reservation is within service hours
        if (reservationHour >= service.startHour && reservationHour <= service.endHour) {
          const name = row.get('Name') || 'N/A';
          const party = parseInt(row.get('PartySize') || 0);
          const source = row.get('Source') || 'N/A';
          const phone = sheetHasPhoneEmail ? (row.get('PhoneNumber') || '') : '';
          const email = sheetHasPhoneEmail ? (row.get('Email') || '') : '';
          const arrived = sheetHasArrivalTracking ? (row.get('Arrived') || 'No') : 'No';
          
          reservations.push({
            rowIndex: index,
            name,
            party,
            time: reservationDate.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
            source,
            phone,
            email,
            arrived: arrived === 'Yes' || arrived === 'TRUE' || arrived === true,
            dateTime: reservationDate
          });
        }
      }
    });
    
    // Sort by time
    reservations.sort((a, b) => a.dateTime - b.dateTime);
    
    return reservations;
  } catch (error) {
    console.error('Error getting reservations by service:', error);
    return [];
  }
}

// Mark reservation as arrived/not arrived
async function toggleArrivalStatus(rowIndex, currentStatus) {
  try {
    if (!sheet || !sheetHasArrivalTracking) {
      throw new Error('Arrival tracking not available');
    }
    
    await sheet.loadHeaderRow();
    const rows = await sheet.getRows();
    
    if (rowIndex >= rows.length) {
      throw new Error('Invalid row index');
    }
    
    const row = rows[rowIndex];
    const newStatus = currentStatus ? 'No' : 'Yes';
    
    await row.assign({ Arrived: newStatus });
    await row.save();
    
    console.log(`✅ Toggled arrival status for row ${rowIndex}: ${currentStatus} → ${!currentStatus}`);
    
    return !currentStatus;
  } catch (error) {
    console.error('Error toggling arrival status:', error);
    throw error;
  }
}

// Get arrival statistics for a service
async function getArrivalStats(serviceType) {
  const reservations = await getTodayReservationsByService(serviceType);
  
  const total = reservations.length;
  const arrived = reservations.filter(r => r.arrived).length;
  const totalPeople = reservations.reduce((sum, r) => sum + r.party, 0);
  const arrivedPeople = reservations.filter(r => r.arrived).reduce((sum, r) => sum + r.party, 0);
  
  return {
    totalReservations: total,
    arrivedReservations: arrived,
    totalPeople,
    arrivedPeople,
    reservationRate: total > 0 ? Math.round((arrived / total) * 100) : 0,
    peopleRate: totalPeople > 0 ? Math.round((arrivedPeople / totalPeople) * 100) : 0
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// GOOGLE SERVICES INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════

// ENHANCED: Check if sheet has Phone/Email columns AND Arrival tracking
async function checkSheetStructure() {
  try {
    await sheet.loadHeaderRow();
    const headers = sheet.headerValues;
    console.log('📋 Current sheet headers:', headers);
    
    const hasPhone = headers.includes('PhoneNumber');
    const hasEmail = headers.includes('Email');
    const hasArrived = headers.includes('Arrived');
    
    sheetHasPhoneEmail = hasPhone && hasEmail;
    sheetHasArrivalTracking = hasArrived;
    
    console.log(`📞 PhoneNumber column: ${hasPhone ? '✅ EXISTS' : '❌ MISSING'}`);
    console.log(`📧 Email column: ${hasEmail ? '✅ EXISTS' : '❌ MISSING'}`);
    console.log(`👥 Arrived column: ${hasArrived ? '✅ EXISTS' : '❌ MISSING'}`);
    console.log(`🔄 Enhanced mode: ${sheetHasPhoneEmail ? '✅ ENABLED' : '❌ DISABLED (backward compatibility)'}`);
    console.log(`📊 Arrival tracking: ${sheetHasArrivalTracking ? '✅ ENABLED' : '❌ DISABLED'}`);
    
    return { hasPhoneEmail: sheetHasPhoneEmail, hasArrivalTracking: sheetHasArrivalTracking };
  } catch (error) {
    console.error('❌ Error checking sheet structure:', error);
    sheetHasPhoneEmail = false;
    sheetHasArrivalTracking = false;
    return { hasPhoneEmail: false, hasArrivalTracking: false };
  }
}

// Initialize Google Sheets and Calendar
async function initializeGoogleServices() {
  try {
    console.log('🔄 Initializing Google Services...');
    
    // Use environment variable for credentials in production
    let credentials;
    if (process.env.GOOGLE_CREDENTIALS) {
      console.log('✅ Using GOOGLE_CREDENTIALS from environment');
      try {
        credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
        console.log('✅ Successfully parsed Google credentials from environment');
      } catch (parseError) {
        console.error('❌ Failed to parse GOOGLE_CREDENTIALS JSON:', parseError.message);
        throw new Error('Invalid GOOGLE_CREDENTIALS format');
      }
    } else {
      console.log('✅ Using credentials.json file');
      try {
        credentials = JSON.parse(
          await readFile(new URL('./credentials.json', import.meta.url))
        );
      } catch (fileError) {
        console.error('❌ Failed to read credentials.json:', fileError.message);
        throw new Error('credentials.json file not found or invalid');
      }
    }
    
    console.log('✅ Credentials loaded, creating JWT...');
    console.log('📧 Using service account:', credentials.client_email);
    
    serviceAccountAuth = new JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/calendar',
      ],
    });
    
    console.log('✅ JWT created, connecting to Google Services...');
    
    // Initialize Google Sheets
    doc = new GoogleSpreadsheet(SHEET_ID, serviceAccountAuth);
    await doc.loadInfo();
    sheet = doc.sheetsByIndex[0];
    
    // ENHANCED: Check sheet structure for new columns
    await checkSheetStructure();
    
    // Initialize Google Calendar
    calendar = google.calendar({ version: 'v3', auth: serviceAccountAuth });
    
    console.log('✅ Google Services initialized successfully');
    console.log(`📊 Connected to sheet: ${doc.title}`);
    console.log(`📋 Sheet name: ${sheet.title}`);
  } catch (error) {
    console.error('❌ Failed to initialize Google Services:', error);
    console.error('Error details:', error.message);
    if (error.stack) {
      console.error('Stack trace:', error.stack);
    }
    process.exit(1);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// BOOKING FUNCTIONS - ENHANCED WITH PHONE/EMAIL SUPPORT
// ═══════════════════════════════════════════════════════════════════════════

// ENHANCED: booking function with optional phone/email and arrival tracking
async function addBooking({ name, party, datetime, source, phoneNumber = '', email = '' }) {
  if (!sheet || !calendar) {
    throw new Error('Google Services not initialized');
  }
  
  console.log(`📝 Adding booking: ${name}, ${party} people, ${datetime}, via ${source}`);
  if (phoneNumber) console.log(`📞 Phone: ${phoneNumber}`);
  if (email) console.log(`📧 Email: ${email}`);
  
  // Create row data - SAFE: only add phone/email/arrived if columns exist
  let rowData = {
    Timestamp: new Date().toISOString(),
    Name: name,
    PartySize: party,
    DateTime: datetime,
    Source: source
  };
  
  // Only add phone/email if sheet has those columns
  if (sheetHasPhoneEmail) {
    rowData.PhoneNumber = phoneNumber || '';
    rowData.Email = email || '';
    console.log('✅ Adding phone/email to enhanced sheet');
  }
  
  // Only add arrival tracking if sheet has that column
  if (sheetHasArrivalTracking) {
    rowData.Arrived = 'No'; // Default to not arrived
    console.log('✅ Adding arrival tracking to enhanced sheet');
  }
  
  if (!sheetHasPhoneEmail && !sheetHasArrivalTracking) {
    console.log('⚠️ Using backward compatibility mode (no enhanced columns)');
  }
  
  // Add to Google Sheets
  await sheet.addRow(rowData);

  // Add to Google Calendar - ENHANCED with contact info
  try {
    const startDate = new Date(datetime);
    const endDate = new Date(startDate.getTime() + (2 * 60 * 60 * 1000)); // 2 hours duration
    
    // Build contact info for calendar
    const contactInfo = [];
    if (phoneNumber) contactInfo.push(`📞 ${phoneNumber}`);
    if (email) contactInfo.push(`📧 ${email}`);
    
    const event = {
      summary: `Réservation: ${name} (${party} pers.)`,
      description: `Réservation pour ${party} personne(s)\nNom: ${name}\nSource: ${source}\n\n${contactInfo.length > 0 ? contactInfo.join('\n') : '📞 Contact: Restaurant'}`,
      start: {
        dateTime: startDate.toISOString(),
        timeZone: 'Europe/Paris',
      },
      end: {
        dateTime: endDate.toISOString(),
        timeZone: 'Europe/Paris',
      },
    };

    const calendarEvent = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      resource: event,
    });

    console.log(`📅 Calendar event created: ${calendarEvent.data.id}`);
  } catch (calError) {
    console.error('❌ Failed to create calendar event:', calError.message);
    // Don't throw - we still want the sheet entry to succeed
  }
}

// ENHANCED: Booking function with capacity check and phone/email
async function addBookingWithCapacityCheck({ name, party, datetime, source, phoneNumber = '', email = '' }) {
  // Vérifier la capacité avant d'ajouter
  const capacityCheck = await checkCapacityAvailable(datetime, party);
  
  if (!capacityCheck.available && source === 'Webflow') {
    // Bloquer automatiquement les réservations Webflow si complet ou fermé
    throw new Error(`Service ${capacityCheck.service} non disponible. ${capacityCheck.reason}`);
  }
  
  if (!capacityCheck.available && source === 'Phone') {
    // Pour le téléphone, proposer la liste d'attente
    const waitingId = `${Date.now()}_${name}`;
    waitingList.set(waitingId, {
      name,
      party,
      datetime,
      source,
      phoneNumber,
      email,
      timestamp: new Date()
    });
    
    throw new Error(`${capacityCheck.reason}: ${capacityCheck.service}. Ajouté en liste d'attente.`);
  }
  
  // Si capacité OK, procéder normalement avec la fonction originale
  await addBooking({ name, party, datetime, source, phoneNumber, email });
  return capacityCheck;
}

// Get calendar events for a date range
async function getCalendarEvents(startDate, endDate) {
  try {
    const response = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: startDate.toISOString(),
      timeMax: endDate.toISOString(),
      orderBy: 'startTime',
      singleEvents: true,
    });

    return response.data.items || [];
  } catch (error) {
    console.error('Failed to get calendar events:', error);
    return [];
  }
}

// Get this week's reservations
async function getWeekReservations() {
  const now = new Date();
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - now.getDay() + 1); // Monday
  startOfWeek.setHours(0, 0, 0, 0);
  
  const endOfWeek = new Date(startOfWeek);
  endOfWeek.setDate(startOfWeek.getDate() + 6); // Sunday
  endOfWeek.setHours(23, 59, 59, 999);

  const events = await getCalendarEvents(startOfWeek, endOfWeek);
  
  // Group events by day
  const eventsByDay = {};
  const dayNames = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
  
  events.forEach(event => {
    if (event.start && event.start.dateTime) {
      const eventDate = new Date(event.start.dateTime);
      const dayKey = eventDate.toISOString().split('T')[0];
      const dayName = dayNames[eventDate.getDay() === 0 ? 6 : eventDate.getDay() - 1];
      
      if (!eventsByDay[dayKey]) {
        eventsByDay[dayKey] = {
          dayName,
          date: eventDate.getDate() + '/' + (eventDate.getMonth() + 1),
          events: []
        };
      }
      
      eventsByDay[dayKey].events.push({
        time: eventDate.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
        summary: event.summary || 'Réservation',
        description: event.description || ''
      });
    }
  });

  return eventsByDay;
}

// Notify Telegram
async function notifyTelegram(msg) {
  try {
    await bot.telegram.sendMessage(TELEGRAM_CHAT_ID, msg, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Failed to send Telegram notification:', error);
  }
}

// Get today's date in YYYY-MM-DD format (local timezone)
function getTodayString() {
  const today = new Date();
  return today.getFullYear() + '-' + 
         String(today.getMonth() + 1).padStart(2, '0') + '-' + 
         String(today.getDate()).padStart(2, '0');
}

// Generate calendar for current and next month - FIXED VERSION
function generateCalendar() {
  const today = new Date();
  const todayStr = getTodayString();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.getFullYear() + '-' + 
                     String(tomorrow.getMonth() + 1).padStart(2, '0') + '-' + 
                     String(tomorrow.getDate()).padStart(2, '0');
  
  const currentMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  const nextMonth = new Date(today.getFullYear(), today.getMonth() + 1, 1);
  
  const months = [currentMonth, nextMonth];
  const buttons = [];
  
  months.forEach(month => {
    const monthName = month.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
    buttons.push([Markup.button.callback(`📅 ${monthName}`, `month_${month.getMonth()}_${month.getFullYear()}`)]);
    
    const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    const monthButtons = [];
    
    for (let day = 1; day <= daysInMonth; day++) {
      const date = new Date(month.getFullYear(), month.getMonth(), day);
      const dateStr = date.getFullYear() + '-' + 
                     String(date.getMonth() + 1).padStart(2, '0') + '-' + 
                     String(date.getDate()).padStart(2, '0');
      
      // Skip past dates (but not today)
      if (dateStr < todayStr) continue;
      
      // Always include today and tomorrow regardless of day of week
      const isToday = dateStr === todayStr;
      const isTomorrow = dateStr === tomorrowStr;
      
      // For other dates, skip Sunday (0) and Monday (1) - restaurant closed days
      if (!isToday && !isTomorrow && (date.getDay() === 0 || date.getDay() === 1)) {
        continue;
      }
      
      const dayName = date.toLocaleDateString('fr-FR', { weekday: 'short' });
      
      // Add special indicators for today and tomorrow
      let buttonText = `${day} ${dayName}`;
      if (isToday) {
        buttonText = `🔥 ${day} ${dayName} (Aujourd'hui)`;
      } else if (isTomorrow) {
        buttonText = `⭐ ${day} ${dayName} (Demain)`;
      }
      
      monthButtons.push(Markup.button.callback(buttonText, `date_${dateStr}`));
      
      if (monthButtons.length === 4) {
        buttons.push([...monthButtons]);
        monthButtons.length = 0;
      }
    }
    
    if (monthButtons.length > 0) {
      buttons.push([...monthButtons]);
    }
    
    buttons.push([Markup.button.callback('─────────', 'spacer')]);
  });
  
  return Markup.inlineKeyboard(buttons);
}

// Generate time slots
function generateTimeSlots() {
  const times = [];
  
  // Lunch slots (12:00 - 15:00)
  times.push([Markup.button.callback('🍽️ DÉJEUNER', 'lunch_header')]);
  const lunchTimes = [];
  for (let hour = 12; hour <= 14; hour++) {
    for (let min = 0; min < 60; min += 30) {
      const timeStr = `${hour.toString().padStart(2, '0')}:${min.toString().padStart(2, '0')}`;
      lunchTimes.push(Markup.button.callback(timeStr, `time_${timeStr}`));
      
      if (lunchTimes.length === 3) {
        times.push([...lunchTimes]);
        lunchTimes.length = 0;
      }
    }
  }
  if (lunchTimes.length > 0) times.push([...lunchTimes]);
  
  times.push([Markup.button.callback('──────', 'spacer2')]);
  
  // Dinner slots (19:00 - 22:00)
  times.push([Markup.button.callback('🌙 DÎNER', 'dinner_header')]);
  const dinnerTimes = [];
  for (let hour = 19; hour <= 21; hour++) {
    for (let min = 0; min < 60; min += 30) {
      const timeStr = `${hour.toString().padStart(2, '0')}:${min.toString().padStart(2, '0')}`;
      dinnerTimes.push(Markup.button.callback(timeStr, `time_${timeStr}`));
      
      if (dinnerTimes.length === 3) {
        times.push([...dinnerTimes]);
        dinnerTimes.length = 0;
      }
    }
  }
  if (dinnerTimes.length > 0) times.push([...dinnerTimes]);
  
  times.push([Markup.button.callback('🔙 Retour au calendrier', 'back_to_calendar')]);
  
  return Markup.inlineKeyboard(times);
}

// Generate party size buttons
function generatePartySizeButtons() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('1', 'party_1'),
      Markup.button.callback('2', 'party_2'),
      Markup.button.callback('3', 'party_3'),
      Markup.button.callback('4', 'party_4')
    ],
    [
      Markup.button.callback('5', 'party_5'),
      Markup.button.callback('6', 'party_6'),
      Markup.button.callback('7', 'party_7'),
      Markup.button.callback('8+', 'party_8')
    ],
    [Markup.button.callback('🔙 Retour aux horaires', 'back_to_time')]
  ]);
}

// NEW: Generate arrival tracking buttons for a service
function generateArrivalTrackingButtons(reservations, serviceType) {
  const buttons = [];
  
  reservations.forEach((reservation, index) => {
    const status = reservation.arrived ? '✅' : '❌';
    const buttonText = `${status} ${reservation.time} - ${reservation.name} (${reservation.party})`;
    
    buttons.push([
      Markup.button.callback(buttonText, `toggle_arrival_${serviceType}_${reservation.rowIndex}`)
    ]);
  });
  
  // Add stats and controls
  buttons.push([Markup.button.callback('📊 Voir statistiques', `arrival_stats_${serviceType}`)]);
  buttons.push([Markup.button.callback('🔄 Actualiser', `refresh_arrivals_${serviceType}`)]);
  buttons.push([Markup.button.callback('🔙 Retour menu', 'back_main')]);
  
  return Markup.inlineKeyboard(buttons);
}

// ═══════════════════════════════════════════════════════════════════════════
// WEBFLOW WEBHOOK WITH CAPACITY MANAGEMENT - ENHANCED WITH EMAIL
// ═══════════════════════════════════════════════════════════════════════════

app.post('/webhook', async (req, res) => {
  try {
    console.log('📲 Webhook reçu:', req.body);
    
    const { name, partySize, dateTime, email } = req.body;
    
    if (!name || !partySize || !dateTime) {
      return res.status(400).json({ 
        error: 'Champs requis manquants: name, partySize, dateTime' 
      });
    }
    
    // Vérifier blocage global
    if (globalOnlineBookingBlocked) {
      console.log('🚫 Réservation bloquée - global');
      return res.status(423).json({ 
        error: 'Réservations temporairement fermées',
        message: 'Veuillez appeler directement le restaurant.'
      });
    }
    
    const when = new Date(dateTime).toISOString();
    
    if (isNaN(new Date(when).getTime())) {
      return res.status(400).json({ error: 'Format de date invalide' });
    }
    
    console.log('✅ Traitement réservation:', { name, party: partySize, datetime: when, source: 'Webflow', email: email || 'N/A' });
    
    try {
      const capacityResult = await addBookingWithCapacityCheck({ 
        name, 
        party: parseInt(partySize), 
        datetime: when, 
        source: 'Webflow',
        email: email || ''
      });
      
      const dateDisplay = new Date(when).toLocaleDateString('fr-FR', { 
        weekday: 'long', day: 'numeric', month: 'long',
        hour: '2-digit', minute: '2-digit'
      });
      
      let notificationMsg = `📲 *Nouvelle réservation web*\n• ${dateDisplay}\n• ${partySize} personne(s): ${name}`;
      if (email && sheetHasPhoneEmail) {
        notificationMsg += `\n• 📧 ${email}`;
      }
      notificationMsg += `\n• Places restantes ${capacityResult.service}: ${capacityResult.remaining}`;
      
      await notifyTelegram(notificationMsg);
      
      console.log('✅ Réservation créée avec succès');
      res.status(200).json({ 
        success: true, 
        message: 'Réservation créée',
        reservation: { name, partySize, dateTime: when },
        remaining: capacityResult.remaining,
        service: capacityResult.service
      });
      
    } catch (capacityError) {
      console.log('⚠️ Réservation refusée:', capacityError.message);
      return res.status(409).json({
        error: 'Service non disponible',
        message: capacityError.message,
        fullBooking: true
      });
    }
    
  } catch (err) {
    console.error('❌ Erreur webhook:', err);
    res.status(500).json({ 
      error: 'Erreur serveur', 
      details: err.message 
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// TELEGRAM BOT COMMANDS AND HANDLERS - ENHANCED WITH ARRIVAL TRACKING
// ═══════════════════════════════════════════════════════════════════════════

// Reply keyboard with buttons (UPDATED WITH ARRIVAL TRACKING)
const mainKeyboard = Markup.keyboard([
  ['➕ Ajouter réservation', "📋 Voir réservations aujourd'hui"],
  ['📅 Voir calendrier', '📊 Voir resa de la semaine'],
  ['📊 Places restantes', '⚙️ Gestion capacité'],
  ['🍽️ Arrivées déjeuner', '🌙 Arrivées dîner'], // NEW: Arrival tracking buttons
  ['🚫 Bloquer toutes résa en ligne', '✅ Activer toutes résa en ligne'],
  ['🔍 Debug sheet'] // Debug button
]).resize();

// /start
bot.start(ctx => {
  const features = [];
  features.push(sheetHasPhoneEmail ? '📞📧 Mode Enhanced' : '⚠️ Mode Compatible');
  features.push(sheetHasArrivalTracking ? '👥 Arrival Tracking' : '❌ No Arrival Tracking');
  
  ctx.reply(
    `Bienvenue chez La Savane! ${features.join(' | ')}\n\nChoisissez une action:`, 
    mainKeyboard
  );
});

// ── NEW: ARRIVAL TRACKING COMMANDS ──────────────────────────────────────────

// Commande: Arrivées déjeuner
bot.hears('🍽️ Arrivées déjeuner', async ctx => {
  if (!sheetHasArrivalTracking) {
    return ctx.reply('❌ Suivi des arrivées non disponible.\n\nVeuillez ajouter une colonne "Arrived" dans votre Google Sheet.');
  }
  
  try {
    const reservations = await getTodayReservationsByService('lunch');
    
    if (reservations.length === 0) {
      return ctx.reply('📋 Aucune réservation pour le déjeuner aujourd\'hui.');
    }
    
    const stats = await getArrivalStats('lunch');
    
    let message = `🍽️ **DÉJEUNER - SUIVI DES ARRIVÉES**\n\n`;
    message += `📊 **Stats:** ${stats.arrivedReservations}/${stats.totalReservations} réservations (${stats.reservationRate}%)\n`;
    message += `👥 **Personnes:** ${stats.arrivedPeople}/${stats.totalPeople} (${stats.peopleRate}%)\n\n`;
    message += `Cliquez sur une réservation pour changer son statut:`;
    
    ctx.reply(message, {
      parse_mode: 'Markdown',
      ...generateArrivalTrackingButtons(reservations, 'lunch')
    });
  } catch (error) {
    console.error('Error showing lunch arrivals:', error);
    ctx.reply('❌ Erreur lors de la récupération des arrivées déjeuner');
  }
});

// Commande: Arrivées dîner
bot.hears('🌙 Arrivées dîner', async ctx => {
  if (!sheetHasArrivalTracking) {
    return ctx.reply('❌ Suivi des arrivées non disponible.\n\nVeuillez ajouter une colonne "Arrived" dans votre Google Sheet.');
  }
  
  try {
    const reservations = await getTodayReservationsByService('dinner');
    
    if (reservations.length === 0) {
      return ctx.reply('📋 Aucune réservation pour le dîner aujourd\'hui.');
    }
    
    const stats = await getArrivalStats('dinner');
    
    let message = `🌙 **DÎNER - SUIVI DES ARRIVÉES**\n\n`;
    message += `📊 **Stats:** ${stats.arrivedReservations}/${stats.totalReservations} réservations (${stats.reservationRate}%)\n`;
    message += `👥 **Personnes:** ${stats.arrivedPeople}/${stats.totalPeople} (${stats.peopleRate}%)\n\n`;
    message += `Cliquez sur une réservation pour changer son statut:`;
    
    ctx.reply(message, {
      parse_mode: 'Markdown',
      ...generateArrivalTrackingButtons(reservations, 'dinner')
    });
  } catch (error) {
    console.error('Error showing dinner arrivals:', error);
    ctx.reply('❌ Erreur lors de la récupération des arrivées dîner');
  }
});

// ── NEW: ARRIVAL TRACKING CALLBACKS ─────────────────────────────────────────

// Toggle arrival status
bot.action(/^toggle_arrival_(lunch|dinner)_(\d+)$/, async ctx => {
  const serviceType = ctx.match[1];
  const rowIndex = parseInt(ctx.match[2]);
  
  try {
    const reservations = await getTodayReservationsByService(serviceType);
    const reservation = reservations.find(r => r.rowIndex === rowIndex);
    
    if (!reservation) {
      return ctx.answerCbQuery('❌ Réservation non trouvée');
    }
    
    const newStatus = await toggleArrivalStatus(rowIndex, reservation.arrived);
    
    // Update the display
    const updatedReservations = await getTodayReservationsByService(serviceType);
    const stats = await getArrivalStats(serviceType);
    
    const serviceName = serviceType === 'lunch' ? 'DÉJEUNER' : 'DÎNER';
    const serviceEmoji = serviceType === 'lunch' ? '🍽️' : '🌙';
    
    let message = `${serviceEmoji} **${serviceName} - SUIVI DES ARRIVÉES**\n\n`;
    message += `📊 **Stats:** ${stats.arrivedReservations}/${stats.totalReservations} réservations (${stats.reservationRate}%)\n`;
    message += `👥 **Personnes:** ${stats.arrivedPeople}/${stats.totalPeople} (${stats.peopleRate}%)\n\n`;
    message += `Cliquez sur une réservation pour changer son statut:`;
    
    ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      ...generateArrivalTrackingButtons(updatedReservations, serviceType)
    });
    
    const statusText = newStatus ? 'ARRIVÉ' : 'NON ARRIVÉ';
    ctx.answerCbQuery(`✅ ${reservation.name} marqué comme ${statusText}`);
    
  } catch (error) {
    console.error('Error toggling arrival status:', error);
    ctx.answerCbQuery('❌ Erreur lors de la mise à jour');
  }
});

// Show arrival statistics
bot.action(/^arrival_stats_(lunch|dinner)$/, async ctx => {
  const serviceType = ctx.match[1];
  
  try {
    const stats = await getArrivalStats(serviceType);
    const reservations = await getTodayReservationsByService(serviceType);
    
    const serviceName = serviceType === 'lunch' ? 'DÉJEUNER' : 'DÎNER';
    const serviceEmoji = serviceType === 'lunch' ? '🍽️' : '🌙';
    
    let message = `${serviceEmoji} **STATISTIQUES ${serviceName}**\n\n`;
    
    // Overall stats
    message += `📊 **RÉSERVATIONS**\n`;
    message += `• Total: ${stats.totalReservations}\n`;
    message += `• Arrivées: ${stats.arrivedReservations}\n`;
    message += `• Taux: ${stats.reservationRate}%\n\n`;
    
    message += `👥 **PERSONNES**\n`;
    message += `• Total: ${stats.totalPeople}\n`;
    message += `• Arrivées: ${stats.arrivedPeople}\n`;
    message += `• Taux: ${stats.peopleRate}%\n\n`;
    
    // Detailed list
    message += `📋 **DÉTAIL**\n`;
    reservations.forEach(r => {
      const status = r.arrived ? '✅' : '❌';
      message += `${status} ${r.time} - ${r.name} (${r.party})\n`;
    });
    
    ctx.editMessageText(message, { parse_mode: 'Markdown' });
    ctx.answerCbQuery('📊 Statistiques affichées');
    
  } catch (error) {
    console.error('Error showing arrival stats:', error);
    ctx.answerCbQuery('❌ Erreur lors de la récupération des statistiques');
  }
});

// Refresh arrivals
bot.action(/^refresh_arrivals_(lunch|dinner)$/, async ctx => {
  const serviceType = ctx.match[1];
  
  try {
    const reservations = await getTodayReservationsByService(serviceType);
    const stats = await getArrivalStats(serviceType);
    
    const serviceName = serviceType === 'lunch' ? 'DÉJEUNER' : 'DÎNER';
    const serviceEmoji = serviceType === 'lunch' ? '🍽️' : '🌙';
    
    let message = `${serviceEmoji} **${serviceName} - SUIVI DES ARRIVÉES**\n\n`;
    message += `📊 **Stats:** ${stats.arrivedReservations}/${stats.totalReservations} réservations (${stats.reservationRate}%)\n`;
    message += `👥 **Personnes:** ${stats.arrivedPeople}/${stats.totalPeople} (${stats.peopleRate}%)\n\n`;
    message += `Cliquez sur une réservation pour changer son statut:`;
    
    ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      ...generateArrivalTrackingButtons(reservations, serviceType)
    });
    
    ctx.answerCbQuery('🔄 Liste actualisée');
    
  } catch (error) {
    console.error('Error refreshing arrivals:', error);
    ctx.answerCbQuery('❌ Erreur lors de l\'actualisation');
  }
});

// ── CAPACITY MANAGEMENT COMMANDS ─────────────────────────────────────────────

// Commande: Places restantes
bot.hears('📊 Places restantes', async ctx => {
  try {
    const status = await getTodayCapacityStatus();
    
    let message = "*📊 PLACES RESTANTES AUJOURD'HUI*\n\n";
    
    // Déjeuner
    message += `🍽️ **DÉJEUNER (12h-14h)**\n`;
    if (status.lunch.blocked) {
      message += `🚫 SERVICE FERMÉ\n\n`;
    } else {
      message += `• Occupé: ${status.lunch.used}/${status.lunch.max} places (${status.lunch.percentage}%)\n`;
      message += `• **Restantes: ${status.lunch.remaining} places**\n`;
      message += status.lunch.remaining === 0 ? "🔴 COMPLET\n\n" : 
                 status.lunch.remaining <= 10 ? "🟡 BIENTÔT COMPLET\n\n" : "🟢 DISPONIBLE\n\n";
    }
    
    // Dîner
    message += `🌙 **DÎNER (19h-22h)**\n`;
    if (status.dinner.blocked) {
      message += `🚫 SERVICE FERMÉ\n\n`;
    } else {
      message += `• Occupé: ${status.dinner.used}/${status.dinner.max} places (${status.dinner.percentage}%)\n`;
      message += `• **Restantes: ${status.dinner.remaining} places**\n`;
      message += status.dinner.remaining === 0 ? "🔴 COMPLET\n\n" : 
                 status.dinner.remaining <= 10 ? "🟡 BIENTÔT COMPLET\n\n" : "🟢 DISPONIBLE\n\n";
    }
    
    // État réservations en ligne
    message += `🌐 **RÉSERVATIONS EN LIGNE**\n`;
    message += globalOnlineBookingBlocked ? "🚫 TOUTES BLOQUÉES" : "✅ ACTIVES";
    
    // Liste d'attente
    if (waitingList.size > 0) {
      message += `\n\n⏳ **LISTE D'ATTENTE**: ${waitingList.size} demande(s)`;
    }
    
    // Mode status
    const features = [];
    features.push(sheetHasPhoneEmail ? '📞📧 Enhanced' : '⚠️ Compatible');
    features.push(sheetHasArrivalTracking ? '👥 Arrival Tracking' : '❌ No Arrival Tracking');
    message += `\n\n🔧 **MODE**: ${features.join(' | ')}`;
    
    ctx.reply(message, { parse_mode: 'Markdown' });
    
  } catch (error) {
    console.error('Erreur places restantes:', error);
    ctx.reply('❌ Erreur lors du calcul des places restantes');
  }
});

// ENHANCED: Debug sheet command
bot.hears('🔍 Debug sheet', async ctx => {
  try {
    if (!sheet) {
      return ctx.reply('❌ Sheet non initialisé');
    }
    
    await sheet.loadHeaderRow();
    const rows = await sheet.getRows();
    
    let message = `🔍 **DEBUG GOOGLE SHEET**\n\n`;
    message += `📊 Total lignes: ${rows.length}\n`;
    message += `📋 Headers: ${sheet.headerValues.join(', ')}\n`;
    message += `🔧 Enhanced mode: ${sheetHasPhoneEmail ? 'ON' : 'OFF'}\n`;
    message += `👥 Arrival tracking: ${sheetHasArrivalTracking ? 'ON' : 'OFF'}\n\n`;
    
    // Afficher les 5 dernières réservations
    const recentRows = rows.slice(-5);
    message += `📅 **5 dernières réservations:**\n`;
    
    recentRows.forEach((row, index) => {
      const timestamp = row.get('Timestamp') || 'N/A';
      const dateTime = row.get('DateTime') || 'N/A';
      const name = row.get('Name') || 'N/A';
      const partySize = row.get('PartySize') || 'N/A';
      const source = row.get('Source') || 'N/A';
      const arrived = sheetHasArrivalTracking ? (row.get('Arrived') || 'N/A') : 'N/A';
      
      message += `**${index + 1}.** ${name}\n`;
      message += `   📅 DateTime: ${dateTime}\n`;
      message += `   👥 PartySize: ${partySize}\n`;
      message += `   📱 Source: ${source}\n`;
      
      // Only show phone/email if enhanced mode
      if (sheetHasPhoneEmail) {
        const phoneNumber = row.get('PhoneNumber') || 'N/A';
        const email = row.get('Email') || 'N/A';
        message += `   📞 Phone: ${phoneNumber}\n`;
        message += `   📧 Email: ${email}\n`;
      }
      
      // Show arrival status if available
      if (sheetHasArrivalTracking) {
        message += `   👥 Arrived: ${arrived}\n`;
      }
      
      message += `   ⏰ Timestamp: ${timestamp}\n\n`;
    });
    
    ctx.reply(message, { parse_mode: 'Markdown' });
    
  } catch (error) {
    console.error('Debug sheet error:', error);
    ctx.reply(`❌ Erreur debug: ${error.message}`);
  }
});

// NEW: Refresh command to check columns
bot.command('refresh', async ctx => {
  try {
    const oldPhoneEmail = sheetHasPhoneEmail;
    const oldArrivalTracking = sheetHasArrivalTracking;
    
    await checkSheetStructure();
    
    let message = '🔄 **Sheet rechargé**\n\n';
    
    // Check for changes
    if (sheetHasPhoneEmail && !oldPhoneEmail) {
      message += '🎉 **Mode Enhanced activé!**\nLes colonnes PhoneNumber et Email ont été détectées.\n\n';
    } else if (!sheetHasPhoneEmail && oldPhoneEmail) {
      message += '⚠️ **Retour au mode Compatible**\nLes colonnes PhoneNumber/Email ne sont plus détectées.\n\n';
    }
    
    if (sheetHasArrivalTracking && !oldArrivalTracking) {
      message += '🎉 **Arrival Tracking activé!**\nLa colonne Arrived a été détectée.\n\n';
    } else if (!sheetHasArrivalTracking && oldArrivalTracking) {
      message += '⚠️ **Arrival Tracking désactivé**\nLa colonne Arrived n\'est plus détectée.\n\n';
    }
    
    const features = [];
    features.push(sheetHasPhoneEmail ? '📞📧 Enhanced' : '⚠️ Compatible');
    features.push(sheetHasArrivalTracking ? '👥 Arrival Tracking' : '❌ No Arrival Tracking');
    message += `**Mode actuel:** ${features.join(' | ')}`;
    
    ctx.reply(message, { parse_mode: 'Markdown' });
  } catch (error) {
    ctx.reply('❌ Erreur lors du rechargement');
  }
});

// Commande: Gestion capacité
bot.hears('⚙️ Gestion capacité', ctx => {
  const capacityKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📊 Voir statut complet', 'capacity_status')],
    [
      Markup.button.callback('🍽️ Gérer déjeuner', 'manage_lunch'),
      Markup.button.callback('🌙 Gérer dîner', 'manage_dinner')
    ],
    [Markup.button.callback('📋 Liste d\'attente', 'waitlist_view')],
    [Markup.button.callback('🔙 Retour menu', 'back_main')]
  ]);
  
  ctx.reply('⚙️ **GESTION DE CAPACITÉ**\n\nChoisissez une option:', {
    parse_mode: 'Markdown',
    ...capacityKeyboard
  });
});

// Commande: Bloquer toutes réservations en ligne
bot.hears('🚫 Bloquer toutes résa en ligne', ctx => {
  globalOnlineBookingBlocked = true;
  ctx.reply('🚫 **TOUTES LES RÉSERVATIONS EN LIGNE BLOQUÉES**\n\nWebflow complètement désactivé.', {
    parse_mode: 'Markdown'
  });
});

// Commande: Activer toutes réservations en ligne
bot.hears('✅ Activer toutes résa en ligne', ctx => {
  globalOnlineBookingBlocked = false;
  ctx.reply('✅ **TOUTES LES RÉSERVATIONS EN LIGNE ACTIVÉES**\n\nWebflow réactivé (selon capacités).', {
    parse_mode: 'Markdown'
  });
});

// ── CAPACITY MANAGEMENT INLINE CALLBACKS ────────────────────────────────────

// Voir statut complet
bot.action('capacity_status', async ctx => {
  const status = await getTodayCapacityStatus();
  
  let message = `📊 **STATUT COMPLET**\n\n`;
  
  // Configuration
  message += `⚙️ **CONFIGURATION**\n`;
  message += `🍽️ Déjeuner: ${CAPACITY_CONFIG.lunch.maxCapacity} places (${CAPACITY_CONFIG.lunch.startHour}h-${CAPACITY_CONFIG.lunch.endHour}h)\n`;
  message += `🌙 Dîner: ${CAPACITY_CONFIG.dinner.maxCapacity} places (${CAPACITY_CONFIG.dinner.startHour}h-${CAPACITY_CONFIG.dinner.endHour}h)\n\n`;
  
  // Statut aujourd'hui
  message += `📅 **AUJOURD'HUI**\n`;
  message += `🍽️ Déjeuner: ${status.lunch.used}/${status.lunch.max} (${status.lunch.remaining} libres)\n`;
  message += `🌙 Dîner: ${status.dinner.used}/${status.dinner.max} (${status.dinner.remaining} libres)\n\n`;
  
  // État des services
  message += `🚦 **ÉTAT DES SERVICES**\n`;
  message += `🍽️ Déjeuner: ${status.lunch.blocked ? '🚫 FERMÉ' : '✅ OUVERT'}\n`;
  message += `🌙 Dîner: ${status.dinner.blocked ? '🚫 FERMÉ' : '✅ OUVERT'}\n`;
  message += `🌐 Global: ${globalOnlineBookingBlocked ? '🚫 BLOQUÉ' : '✅ ACTIF'}`;
  
  ctx.editMessageText(message, { parse_mode: 'Markdown' });
  ctx.answerCbQuery();
});

// Gestion déjeuner
bot.action('manage_lunch', ctx => {
  const lunchKeyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback(
        CAPACITY_CONFIG.lunch.blocked ? '✅ Ouvrir déjeuner' : '🚫 Fermer déjeuner', 
        'toggle_lunch'
      )
    ],
    [Markup.button.callback('📝 Modifier capacité', 'edit_lunch_capacity')],
    [Markup.button.callback('🔙 Retour', 'capacity_status')]
  ]);
  
  const status = CAPACITY_CONFIG.lunch.blocked ? '🚫 FERMÉ' : '✅ OUVERT';
  
  ctx.editMessageText(
    `🍽️ **GESTION DÉJEUNER**\n\n` +
    `Capacité: ${CAPACITY_CONFIG.lunch.maxCapacity} places\n` +
    `Horaires: ${CAPACITY_CONFIG.lunch.startHour}h-${CAPACITY_CONFIG.lunch.endHour}h\n` +
    `Statut: ${status}\n\n` +
    `Choisissez une action:`,
    { parse_mode: 'Markdown', ...lunchKeyboard }
  );
  ctx.answerCbQuery();
});

// Gestion dîner
bot.action('manage_dinner', ctx => {
  const dinnerKeyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback(
        CAPACITY_CONFIG.dinner.blocked ? '✅ Ouvrir dîner' : '🚫 Fermer dîner', 
        'toggle_dinner'
      )
    ],
    [Markup.button.callback('📝 Modifier capacité', 'edit_dinner_capacity')],
    [Markup.button.callback('🔙 Retour', 'capacity_status')]
  ]);
  
  const status = CAPACITY_CONFIG.dinner.blocked ? '🚫 FERMÉ' : '✅ OUVERT';
  
  ctx.editMessageText(
    `🌙 **GESTION DÎNER**\n\n` +
    `Capacité: ${CAPACITY_CONFIG.dinner.maxCapacity} places\n` +
    `Horaires: ${CAPACITY_CONFIG.dinner.startHour}h-${CAPACITY_CONFIG.dinner.endHour}h\n` +
    `Statut: ${status}\n\n` +
    `Choisissez une action:`,
    { parse_mode: 'Markdown', ...dinnerKeyboard }
  );
  ctx.answerCbQuery();
});

// Toggle services
bot.action('toggle_lunch', async ctx => {
  CAPACITY_CONFIG.lunch.blocked = !CAPACITY_CONFIG.lunch.blocked;
  const status = CAPACITY_CONFIG.lunch.blocked ? 'FERMÉ' : 'OUVERT';
  
  ctx.answerCbQuery(`Déjeuner maintenant ${status}`);
  
  ctx.editMessageText(
    `🍽️ Service déjeuner maintenant **${status}**\n\n` +
    `Les réservations en ligne pour le déjeuner sont ${CAPACITY_CONFIG.lunch.blocked ? 'bloquées' : 'autorisées'}.`,
    { parse_mode: 'Markdown' }
  );
  
  await notifyTelegram(
    `🍽️ *Service déjeuner ${status}*\n• Par: ${ctx.from.first_name || ctx.from.username}\n• Réservations en ligne: ${CAPACITY_CONFIG.lunch.blocked ? 'BLOQUÉES' : 'AUTORISÉES'}`
  );
});

bot.action('toggle_dinner', async ctx => {
  CAPACITY_CONFIG.dinner.blocked = !CAPACITY_CONFIG.dinner.blocked;
  const status = CAPACITY_CONFIG.dinner.blocked ? 'FERMÉ' : 'OUVERT';
  
  ctx.answerCbQuery(`Dîner maintenant ${status}`);
  
  ctx.editMessageText(
    `🌙 Service dîner maintenant **${status}**\n\n` +
    `Les réservations en ligne pour le dîner sont ${CAPACITY_CONFIG.dinner.blocked ? 'bloquées' : 'autorisées'}.`,
    { parse_mode: 'Markdown' }
  );
  
  await notifyTelegram(
    `🌙 *Service dîner ${status}*\n• Par: ${ctx.from.first_name || ctx.from.username}\n• Réservations en ligne: ${CAPACITY_CONFIG.dinner.blocked ? 'BLOQUÉES' : 'AUTORISÉES'}`
  );
});

// Modifier capacités
bot.action('edit_lunch_capacity', ctx => {
  ctx.editMessageText(
    `🍽️ **Modifier capacité déjeuner**\n\nCapacité actuelle: ${CAPACITY_CONFIG.lunch.maxCapacity} personnes\n\nEnvoyez la nouvelle capacité:`,
    { parse_mode: 'Markdown' }
  );
  
  const userId = ctx.from.id;
  if (!userSessions.has(userId)) {
    userSessions.set(userId, {});
  }
  userSessions.get(userId).waitingForCapacityChange = 'lunch';
  ctx.answerCbQuery();
});

bot.action('edit_dinner_capacity', ctx => {
  ctx.editMessageText(
    `🌙 **Modifier capacité dîner**\n\nCapacité actuelle: ${CAPACITY_CONFIG.dinner.maxCapacity} personnes\n\nEnvoyez la nouvelle capacité:`,
    { parse_mode: 'Markdown' }
  );
  
  const userId = ctx.from.id;
  if (!userSessions.has(userId)) {
    userSessions.set(userId, {});
  }
  userSessions.get(userId).waitingForCapacityChange = 'dinner';
  ctx.answerCbQuery();
});

// Liste d'attente
bot.action('waitlist_view', ctx => {
  if (waitingList.size === 0) {
    ctx.editMessageText('📋 **LISTE D\'ATTENTE VIDE**', { parse_mode: 'Markdown' });
  } else {
    let message = `📋 **LISTE D'ATTENTE** (${waitingList.size})\n\n`;
    
    Array.from(waitingList.entries()).forEach(([id, request], index) => {
      const date = new Date(request.datetime).toLocaleDateString('fr-FR');
      const time = new Date(request.datetime).toLocaleTimeString('fr-FR', { 
        hour: '2-digit', minute: '2-digit' 
      });
      
      message += `**${index + 1}.** ${request.name}\n`;
      message += `   📅 ${date} ${time}\n`;
      message += `   👥 ${request.party} pers. (${request.source})\n`;
      if (request.phoneNumber) {
        message += `   📞 ${request.phoneNumber}\n`;
      }
      if (request.email) {
        message += `   📧 ${request.email}\n`;
      }
      message += '\n';
    });
    
    ctx.editMessageText(message, { parse_mode: 'Markdown' });
  }
  ctx.answerCbQuery();
});

// Retour menu
bot.action('back_main', ctx => {
  ctx.deleteMessage();
  ctx.reply('Menu principal:', mainKeyboard);
  ctx.answerCbQuery();
});

// ── ORIGINAL BOOKING COMMANDS ────────────────────────────────────────────────

// Ajouter réservation
bot.hears('➕ Ajouter réservation', ctx => {
  ctx.reply('📅 Choisissez une date pour votre réservation:', generateCalendar());
});

// ENHANCED: Voir réservations aujourd'hui
bot.hears("📋 Voir réservations aujourd'hui", async ctx => {
  try {
    if (!sheet) {
      return ctx.reply('❌ Service non disponible - problème de connexion');
    }
    
    await sheet.loadHeaderRow();
    const rows = await sheet.getRows();
    
    const today = getTodayString();
    console.log('DEBUG: Looking for reservations on:', today);
    
    const todayRows = rows.filter(r => {
      const dateTime = r.get('DateTime');
      const hasDateTime = dateTime && dateTime.length > 0;
      const startsWithToday = hasDateTime && dateTime.startsWith(today);
      return startsWithToday;
    });
    
    console.log('DEBUG: Total rows found:', rows.length);
    console.log('DEBUG: Today rows found:', todayRows.length);
    
    if (!todayRows.length) {
      return ctx.reply("Aucune réservation pour aujourd'hui.");
    }
    
    const lines = todayRows.map(r => {
      const dateTime = r.get('DateTime');
      const t = new Date(dateTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const name = r.get('Name');
      const party = r.get('PartySize');
      
      let line = `– ${t}, ${party} pers.: ${name}`;
      
      // Only show contact info if enhanced mode is active
      if (sheetHasPhoneEmail) {
        const phone = r.get('PhoneNumber');
        const email = r.get('Email');
        if (phone) line += ` 📞 ${phone}`;
        if (email) line += ` 📧 ${email}`;
      }
      
      // Show arrival status if available
      if (sheetHasArrivalTracking) {
        const arrived = r.get('Arrived');
        const status = (arrived === 'Yes' || arrived === 'TRUE' || arrived === true) ? '✅' : '❌';
        line += ` ${status}`;
      }
      
      return line;
    });
    
    ctx.reply("*Réservations aujourd'hui:*\n" + lines.join("\n"), { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Error fetching reservations:', error);
    ctx.reply('❌ Erreur lors de la récupération des réservations');
  }
});

// Voir calendrier
bot.hears('📅 Voir calendrier', async ctx => {
  try {
    const now = new Date();
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    
    const events = await getCalendarEvents(now, endOfMonth);
    
    if (events.length === 0) {
      const url = `https://calendar.google.com/calendar/embed?src=${encodeURIComponent(CALENDAR_ID)}&ctz=Europe/Paris`;
      return ctx.replyWithHTML(`Aucune réservation ce mois-ci.\n\n<a href="${url}">📅 Voir le calendrier complet</a>`);
    }

    let message = "*📅 Réservations ce mois-ci:*\n\n";
    
    const eventsByDate = {};
    events.forEach(event => {
      if (event.start && event.start.dateTime) {
        const eventDate = new Date(event.start.dateTime);
        const dateKey = eventDate.toLocaleDateString('fr-FR', { 
          weekday: 'short', 
          day: 'numeric', 
          month: 'short' 
        });
        
        if (!eventsByDate[dateKey]) {
          eventsByDate[dateKey] = [];
        }
        
        const time = eventDate.toLocaleTimeString('fr-FR', { 
          hour: '2-digit', 
          minute: '2-digit' 
        });
        
        eventsByDate[dateKey].push(`  • ${time} - ${event.summary || 'Réservation'}`);
      }
    });

    Object.keys(eventsByDate).forEach(date => {
      message += `**${date}**\n`;
      message += eventsByDate[date].join('\n');
      message += '\n\n';
    });

    const url = `https://calendar.google.com/calendar/embed?src=${encodeURIComponent(CALENDAR_ID)}&ctz=Europe/Paris`;
    message += `[📅 Voir le calendrier complet](${url})`;

    ctx.reply(message, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Error fetching calendar:', error);
    const url = `https://calendar.google.com/calendar/embed?src=${encodeURIComponent(CALENDAR_ID)}&ctz=Europe/Paris`;
    ctx.replyWithHTML(`❌ Erreur lors de la récupération du calendrier.\n\n<a href="${url}">📅 Voir le calendrier complet</a>`);
  }
});

// Voir resa de la semaine
bot.hears('📊 Voir resa de la semaine', async ctx => {
  try {
    const weekEvents = await getWeekReservations();
    
    if (Object.keys(weekEvents).length === 0) {
      return ctx.reply("📅 *Aucune réservation cette semaine.*", { parse_mode: 'Markdown' });
    }

    let message = "*📊 Réservations de la semaine:*\n\n";
    
    const sortedDays = Object.keys(weekEvents).sort();
    
    sortedDays.forEach(dateKey => {
      const dayData = weekEvents[dateKey];
      message += `**${dayData.dayName} ${dayData.date}**\n`;
      
      dayData.events.forEach(event => {
        message += `  • ${event.time} - ${event.summary}\n`;
      });
      
      message += '\n';
    });

    ctx.reply(message, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Error fetching week reservations:', error);
    ctx.reply('❌ Erreur lors de la récupération des réservations de la semaine');
  }
});

// Keep the old /new command for quick access
bot.command('new', async ctx => {
  try {
    const parts = ctx.message.text.split(' ');
    if (parts.length < 5) {
      return ctx.reply('❌ Format invalide. Utilisez : `/new YYYY-MM-DD HH:MM N Nom`\n\nOu utilisez le bouton "➕ Ajouter réservation" pour une interface plus simple!', { parse_mode: 'Markdown' });
    }
    
    const [, date, time, party, ...nameParts] = parts;
    const name = nameParts.join(' ');
    
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
      return ctx.reply('❌ Format de date/heure invalide. Utilisez YYYY-MM-DD HH:MM', { parse_mode: 'Markdown' });
    }
    
    const when = new Date(`${date}T${time}:00`).toISOString();
    await addBooking({ name, party: +party, datetime: when, source: 'Phone' });
    
    ctx.reply(`✅ Réservation ajoutée : ${date} ${time}, ${party} pers. pour ${name}`);
    await notifyTelegram(
      `📞 *Réservation téléphone*\n• ${date} ${time}\n• ${party} pers.: ${name}`
    );
  } catch (error) {
    console.error('Error adding reservation:', error);
    ctx.reply('❌ Erreur lors de l\'ajout de la réservation');
  }
});

// /list - ENHANCED with arrival status
bot.command('list', async ctx => {
  try {
    if (!sheet) {
      return ctx.reply('❌ Service non disponible - problème de connexion');
    }
    
    await sheet.loadHeaderRow();
    const rows = await sheet.getRows();
    const today = getTodayString();
    const todayRows = rows.filter(r => {
      const dateTime = r.get('DateTime');
      return dateTime && dateTime.startsWith(today);
    });
    
    if (!todayRows.length) {
      return ctx.reply("Aucune réservation pour aujourd'hui.");
    }
    
    const lines = todayRows.map(r => {
      const dateTime = r.get('DateTime');
      const t = new Date(dateTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const name = r.get('Name');
      const party = r.get('PartySize');
      
      let line = `– ${t}, ${party} pers.: ${name}`;
      
      if (sheetHasPhoneEmail) {
        const phone = r.get('PhoneNumber');
        const email = r.get('Email');
        if (phone) line += ` 📞 ${phone}`;
        if (email) line += ` 📧 ${email}`;
      }
      
      // Show arrival status if available
      if (sheetHasArrivalTracking) {
        const arrived = r.get('Arrived');
        const status = (arrived === 'Yes' || arrived === 'TRUE' || arrived === true) ? '✅' : '❌';
        line += ` ${status}`;
      }
      
      return line;
    });
    
    ctx.reply("*Réservations aujourd'hui:*\n" + lines.join("\n"), { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Error listing reservations:', error);
    ctx.reply('❌ Erreur lors de la récupération des réservations');
  }
});

// ── BOOKING FLOW HANDLERS ────────────────────────────────────────────────────

// Handle calendar date selection
bot.action(/^date_(.+)$/, ctx => {
  const selectedDate = ctx.match[1];
  const userId = ctx.from.id;
  
  if (!userSessions.has(userId)) {
    userSessions.set(userId, {});
  }
  userSessions.get(userId).selectedDate = selectedDate;
  
  const dateObj = new Date(selectedDate);
  const dateDisplay = dateObj.toLocaleDateString('fr-FR', { 
    weekday: 'long', 
    day: 'numeric', 
    month: 'long',
    year: 'numeric'
  });
  
  ctx.editMessageText(`📅 Date: ${dateDisplay}\n\n🕐 Choisissez l'heure:`, generateTimeSlots());
});

// Handle time selection
bot.action(/^time_(.+)$/, ctx => {
  const selectedTime = ctx.match[1];
  const userId = ctx.from.id;
  
  if (!userSessions.has(userId)) {
    return ctx.answerCbQuery('❌ Session expirée, recommencez');
  }
  
  userSessions.get(userId).selectedTime = selectedTime;
  
  const session = userSessions.get(userId);
  const dateObj = new Date(session.selectedDate);
  const dateDisplay = dateObj.toLocaleDateString('fr-FR', { 
    weekday: 'long', 
    day: 'numeric', 
    month: 'long'
  });
  
  ctx.editMessageText(
    `📅 Date: ${dateDisplay}\n🕐 Heure: ${selectedTime}\n\n👥 Combien de personnes?`,
    generatePartySizeButtons()
  );
});

// Handle party size selection
bot.action(/^party_(.+)$/, ctx => {
  const partySize = ctx.match[1];
  const userId = ctx.from.id;
  
  if (!userSessions.has(userId)) {
    return ctx.answerCbQuery('❌ Session expirée, recommencez');
  }
  
  userSessions.get(userId).partySize = partySize;
  
  const session = userSessions.get(userId);
  const dateObj = new Date(session.selectedDate);
  const dateDisplay = dateObj.toLocaleDateString('fr-FR', { 
    weekday: 'long', 
    day: 'numeric', 
    month: 'long'
  });
  
  ctx.editMessageText(
    `📅 Date: ${dateDisplay}\n🕐 Heure: ${session.selectedTime}\n👥 Personnes: ${partySize}\n\n📝 Maintenant, envoyez le nom pour la réservation:`
  );
  
  userSessions.get(userId).waitingForName = true;
});

// Handle back buttons
bot.action('back_to_calendar', ctx => {
  ctx.editMessageText('📅 Choisissez une date pour votre réservation:', generateCalendar());
});

bot.action('back_to_time', ctx => {
  const userId = ctx.from.id;
  const session = userSessions.get(userId);
  
  if (session && session.selectedDate) {
    const dateObj = new Date(session.selectedDate);
    const dateDisplay = dateObj.toLocaleDateString('fr-FR', { 
      weekday: 'long', 
      day: 'numeric', 
      month: 'long',
      year: 'numeric'
    });
    
    ctx.editMessageText(`📅 Date: ${dateDisplay}\n\n🕐 Choisissez l'heure:`, generateTimeSlots());
  } else {
    ctx.editMessageText('📅 Choisissez une date pour votre réservation:', generateCalendar());
  }
});

// Handle spacer clicks (do nothing)
bot.action(['spacer', 'spacer2', 'lunch_header', 'dinner_header'], ctx => {
  ctx.answerCbQuery();
});

// Handle month header clicks (do nothing)
bot.action(/^month_/, ctx => {
  ctx.answerCbQuery();
});

// ── ENHANCED TEXT INPUT HANDLER WITH PHONE NUMBER SUPPORT ────────────────────

// Handle name input and capacity changes - ENHANCED with phone support
bot.on('text', async ctx => {
  const userId = ctx.from.id;
  const session = userSessions.get(userId);
  
  // CAPACITY MANAGEMENT: Handle capacity changes
  if (session && session.waitingForCapacityChange) {
    const newCapacity = parseInt(ctx.message.text);
    
    if (isNaN(newCapacity) || newCapacity <= 0) {
      return ctx.reply('❌ Entrez un nombre valide > 0');
    }
    
    const serviceType = session.waitingForCapacityChange;
    const oldCapacity = CAPACITY_CONFIG[serviceType].maxCapacity;
    
    CAPACITY_CONFIG[serviceType].maxCapacity = newCapacity;
    delete session.waitingForCapacityChange;
    
    const serviceName = serviceType === 'lunch' ? 'déjeuner' : 'dîner';
    
    ctx.reply(
      `✅ **Capacité ${serviceName} modifiée**\n\n` +
      `${oldCapacity} → ${newCapacity} personnes`,
      { parse_mode: 'Markdown', ...mainKeyboard }
    );
    
    await notifyTelegram(
      `⚙️ *Capacité ${serviceName} modifiée*\n• ${oldCapacity} → ${newCapacity}\n• Par: ${ctx.from.first_name || ctx.from.username}`
    );
    
    return;
  }
  
  // BOOKING: Handle name input for reservations
  if (session && session.waitingForName) {
    const name = ctx.message.text.trim();
    session.customerName = name;
    session.waitingForName = false;
    
    // Only ask for phone if enhanced mode is active
    if (sheetHasPhoneEmail) {
      session.waitingForPhone = true;
      
      const dateObj = new Date(session.selectedDate);
      const dateDisplay = dateObj.toLocaleDateString('fr-FR', { 
        weekday: 'long', 
        day: 'numeric', 
        month: 'long'
      });
      
      ctx.reply(
        `📅 Date: ${dateDisplay}\n🕐 Heure: ${session.selectedTime}\n👥 Personnes: ${session.partySize}\n📝 Nom: ${name}\n\n📞 **Numéro de téléphone (optionnel)**\n\nTapez le numéro ou "skip" pour ignorer:`
      );
    } else {
      // Skip phone collection in compatible mode
      await processReservation(ctx, session, name, '');
    }
    
    return;
  }
  
  // Handle phone number input (only in enhanced mode)
  if (session && session.waitingForPhone) {
    const phoneInput = ctx.message.text.trim();
    let phoneNumber = '';
    
    if (phoneInput.toLowerCase() !== 'skip' && phoneInput !== '') {
      phoneNumber = phoneInput;
    }
    
    await processReservation(ctx, session, session.customerName, phoneNumber);
    return;
  }
});

// Helper function to process reservation
async function processReservation(ctx, session, name, phoneNumber) {
  const userId = ctx.from.id;
  delete session.waitingForPhone;
  
  try {
    const dateTime = `${session.selectedDate}T${session.selectedTime}:00`;
    console.log('DEBUG: Tentative de réservation:', { 
      selectedDate: session.selectedDate, 
      selectedTime: session.selectedTime, 
      dateTime, 
      party: session.partySize,
      name,
      phoneNumber: phoneNumber || 'N/A'
    });
    
    // Use capacity-aware booking function
    try {
      const capacityResult = await addBookingWithCapacityCheck({
        name,
        party: parseInt(session.partySize),
        datetime: dateTime,
        source: 'Phone',
        phoneNumber: phoneNumber
      });
      
      userSessions.delete(userId);
      
      const dateObj = new Date(session.selectedDate);
      const dateDisplay = dateObj.toLocaleDateString('fr-FR', { 
        weekday: 'long', 
        day: 'numeric', 
        month: 'long'
      });
      
      let confirmationMessage = `✅ *Réservation confirmée!*\n\n` +
        `📅 ${dateDisplay}\n🕐 ${session.selectedTime}\n👥 ${session.partySize} pers.\n📝 ${name}`;
      
      if (phoneNumber && sheetHasPhoneEmail) {
        confirmationMessage += `\n📞 ${phoneNumber}`;
      }
      
      confirmationMessage += `\n📊 Places restantes ${capacityResult.service}: ${capacityResult.remaining}`;
      
      ctx.reply(confirmationMessage, { parse_mode: 'Markdown', ...mainKeyboard });
      
      let notificationMsg = `📞 *Nouvelle réservation*\n• ${dateDisplay} ${session.selectedTime}\n• ${session.partySize} pers.: ${name}`;
      if (phoneNumber && sheetHasPhoneEmail) {
        notificationMsg += `\n• 📞 ${phoneNumber}`;
      }
      notificationMsg += `\n• Restantes ${capacityResult.service}: ${capacityResult.remaining}`;
      
      await notifyTelegram(notificationMsg);
      
    } catch (capacityError) {
      ctx.reply(
        `⚠️ ${capacityError.message}\n\nNous vous contacterons si une place se libère.`,
        { ...mainKeyboard }
      );
      
      userSessions.delete(userId);
      
      let waitingMsg = `⏳ *Liste d'attente*\n• ${name} - ${session.partySize} pers.\n• ${session.selectedDate} ${session.selectedTime}`;
      if (phoneNumber && sheetHasPhoneEmail) {
        waitingMsg += `\n• 📞 ${phoneNumber}`;
      }
      
      await notifyTelegram(waitingMsg);
    }
    
  } catch (error) {
    console.error('Erreur création réservation:', error);
    ctx.reply('❌ Erreur. Réessayez.');
    userSessions.delete(userId);
  }
}

// Error handling for bot
bot.catch((err, ctx) => {
  console.error('Bot error:', err);
});

// ═══════════════════════════════════════════════════════════════════════════
// APPLICATION STARTUP
// ═══════════════════════════════════════════════════════════════════════════

async function startApp() {
  try {
    await initializeGoogleServices();

    // Launch bot (drops any pending updates)
    await bot.launch({ dropPendingUpdates: true });
    console.log('🤖 Telegram bot started successfully');
    
    const features = [];
    features.push(sheetHasPhoneEmail ? '📞📧 Enhanced' : '⚠️ Compatible');
    features.push(sheetHasArrivalTracking ? '👥 Arrival Tracking' : '❌ No Arrival Tracking');
    console.log(`🔧 Mode: ${features.join(' | ')}`);
    
    console.log('📊 Capacity management system active');
    console.log(`🍽️ Lunch capacity: ${CAPACITY_CONFIG.lunch.maxCapacity} (${CAPACITY_CONFIG.lunch.startHour}h-${CAPACITY_CONFIG.lunch.endHour}h)`);
    console.log(`🌙 Dinner capacity: ${CAPACITY_CONFIG.dinner.maxCapacity} (${CAPACITY_CONFIG.dinner.startHour}h-${CAPACITY_CONFIG.dinner.endHour}h)`);
    
    if (sheetHasArrivalTracking) {
      console.log('👥 Arrival tracking enabled - use "🍽️ Arrivées déjeuner" and "🌙 Arrivées dîner" buttons');
    } else {
      console.log('💡 To enable arrival tracking, add an "Arrived" column to your Google Sheet and use /refresh');
    }
  } catch (error) {
    console.error('❌ Failed to start application:', error);
    process.exit(1);
  }
}

// Graceful shutdown handlers
process.once('SIGINT', () => {
  console.log('Received SIGINT, stopping bot...');
  bot.stop('SIGINT');
});

process.once('SIGTERM', () => {
  console.log('Received SIGTERM, stopping bot...');
  bot.stop('SIGTERM');
});

// Kick off startup
startApp();

// ═══════════════════════════════════════════════════════════════════════════
// EXPRESS SERVER (always bind after startApp, so it won't get skipped)
// ═══════════════════════════════════════════════════════════════════════════

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Express server listening on 0.0.0.0:${PORT}`);
  console.log(`📍 Health check: http://0.0.0.0:${PORT}`);
  console.log(`🌐 Webhook endpoint: http://0.0.0.0:${PORT}/webhook`);
});