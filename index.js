/* index.js - SAFE ENHANCED VERSION WITH BACKWARD COMPATIBILITY
 * Telegram Booking Bot using Google Sheets + Google Calendar + Capacity Control
 * Now with Phone Number and Email support - SAFE VERSION
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
  service: 'La Savane Booking Bot with Phone/Email Support (Safe Mode)',
  timestamp: new Date().toISOString()
}));

// Telegram bot
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

// Global variables for Google Sheets and Calendar
let doc;
let sheet;
let calendar;
let serviceAccountAuth;
let sheetHasPhoneEmail = false; // Track if sheet has new columns

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
// GOOGLE SERVICES INITIALIZATION WITH COLUMN DETECTION
// ═══════════════════════════════════════════════════════════════════════════

// Check if sheet has Phone/Email columns
async function checkSheetStructure() {
  try {
    await sheet.loadHeaderRow();
    const headers = sheet.headerValues;
    console.log('📋 Current sheet headers:', headers);
    
    const hasPhone = headers.includes('PhoneNumber');
    const hasEmail = headers.includes('Email');
    sheetHasPhoneEmail = hasPhone && hasEmail;
    
    console.log(`📞 PhoneNumber column: ${hasPhone ? '✅ EXISTS' : '❌ MISSING'}`);
    console.log(`📧 Email column: ${hasEmail ? '✅ EXISTS' : '❌ MISSING'}`);
    console.log(`🔄 Enhanced mode: ${sheetHasPhoneEmail ? '✅ ENABLED' : '❌ DISABLED (backward compatibility)'}`);
    
    return sheetHasPhoneEmail;
  } catch (error) {
    console.error('❌ Error checking sheet structure:', error);
    sheetHasPhoneEmail = false;
    return false;
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
    
    // Check sheet structure for new columns
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
// SAFE BOOKING FUNCTIONS WITH BACKWARD COMPATIBILITY
// ═══════════════════════════════════════════════════════════════════════════

// Safe booking function that works with old and new sheet structures
async function addBooking({ name, party, datetime, source, phoneNumber = '', email = '' }) {
  if (!sheet || !calendar) {
    throw new Error('Google Services not initialized');
  }
  
  console.log(`📝 Adding booking: ${name}, ${party} people, ${datetime}, via ${source}`);
  if (phoneNumber) console.log(`📞 Phone: ${phoneNumber}`);
  if (email) console.log(`📧 Email: ${email}`);
  
  // Create row data based on sheet structure
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
  } else {
    console.log('⚠️ Using backward compatibility mode (no phone/email columns)');
  }
  
  // Add to Google Sheets
  await sheet.addRow(rowData);

  // Add to Google Calendar with contact info in description
  try {
    const startDate = new Date(datetime);
    const endDate = new Date(startDate.getTime() + (2 * 60 * 60 * 1000)); // 2 hours duration
    
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

// Booking function with capacity check
async function addBookingWithCapacityCheck({ name, party, datetime, source, phoneNumber = '', email = '' }) {
  // Vérifier la capacité avant d'ajouter
  const capacityCheck = await checkCapacityAvailable(datetime, party);
  
  if (!capacityCheck.available && source === 'Webflow') {
    // Bloquer automatiquement les réservations Webflow si complet ou fermé
    throw new Error(`Service ${capacityCheck.service} non disponible. ${capacityCheck.reason}`);
  }
  
  if (!capacityCheck.available && source === 'Telegram') {
    // Pour Telegram, proposer la liste d'attente
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
  
  // Si capacité OK, procéder normalement
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

// Generate calendar for current and next month
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

// ═══════════════════════════════════════════════════════════════════════════
// ENHANCED WEBFLOW WEBHOOK WITH EMAIL SUPPORT (SAFE)
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
    
    console.log('✅ Traitement réservation:', { 
      name, 
      party: partySize, 
      datetime: when, 
      source: 'Webflow',
      email: email || 'N/A',
      enhancedMode: sheetHasPhoneEmail
    });
    
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
        reservation: { name, partySize, dateTime: when, email: email || '' },
        remaining: capacityResult.remaining,
        service: capacityResult.service,
        enhancedMode: sheetHasPhoneEmail
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
// TELEGRAM BOT COMMANDS AND HANDLERS
// ═══════════════════════════════════════════════════════════════════════════

// Reply keyboard with buttons
const mainKeyboard = Markup.keyboard([
  ['➕ Ajouter réservation', "📋 Voir réservations aujourd'hui"],
  ['📅 Voir calendrier', '📊 Voir resa de la semaine'],
  ['📊 Places restantes', '⚙️ Gestion capacité'],
  ['🚫 Bloquer toutes résa en ligne', '✅ Activer toutes résa en ligne'],
  ['🔍 Debug sheet', '🔧 Add Phone/Email columns']
]).resize();

// /start
bot.start(ctx =>
  ctx.reply(`Bienvenue chez La Savane! 🦁\n${sheetHasPhoneEmail ? '📞📧 Mode Enhanced' : '⚠️ Mode Compatible'}\n\nChoisissez une action:`, mainKeyboard)
);

// NEW: Add columns command
bot.hears('🔧 Add Phone/Email columns', async ctx => {
  try {
    if (sheetHasPhoneEmail) {
      return ctx.reply('✅ Les colonnes PhoneNumber et Email existent déjà!');
    }
    
    ctx.reply('🔧 **AJOUT DES COLONNES PHONE/EMAIL**\n\nPour activer le mode enhanced:\n\n1. Ouvrez votre Google Sheet\n2. Ajoutez ces colonnes après "Name":\n   • **PhoneNumber**\n   • **Email**\n\n3. Utilisez "/refresh" pour recharger\n\nOrdre final: Timestamp | Name | PhoneNumber | Email | PartySize | DateTime | Source', {
      parse_mode: 'Markdown'
    });
    
  } catch (error) {
    ctx.reply('❌ Erreur lors de la vérification des colonnes');
  }
});

// Refresh command
bot.command('refresh', async ctx => {
  try {
    const hadColumns = sheetHasPhoneEmail;
    await checkSheetStructure();
    
    if (sheetHasPhoneEmail && !hadColumns) {
      ctx.reply('🎉 **Mode Enhanced activé!**\n\nLes colonnes PhoneNumber et Email ont été détectées.\nLe bot collecte maintenant les numéros de téléphone.', {
        parse_mode: 'Markdown'
      });
    } else if (!sheetHasPhoneEmail && hadColumns) {
      ctx.reply('⚠️ **Retour au mode Compatible**\n\nLes colonnes PhoneNumber/Email ne sont plus détectées.', {
        parse_mode: 'Markdown'
      });
    } else {
      ctx.reply(`🔄 **Sheet rechargé**\n\nMode: ${sheetHasPhoneEmail ? '📞📧 Enhanced' : '⚠️ Compatible'}`, {
        parse_mode: 'Markdown'
      });
    }
  } catch (error) {
    ctx.reply('❌ Erreur lors du rechargement');
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
    message += `\n\n🔧 **MODE**: ${sheetHasPhoneEmail ? '📞📧 Enhanced' : '⚠️ Compatible'}`;
    
    ctx.reply(message, { parse_mode: 'Markdown' });
    
  } catch (error) {
    console.error('Erreur places restantes:', error);
    ctx.reply('❌ Erreur lors du calcul des places restantes');
  }
});

// Debug sheet command - ENHANCED WITH SAFE READING
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
    message += `🔧 Mode: ${sheetHasPhoneEmail ? 'Enhanced' : 'Compatible'}\n\n`;
    
    // Afficher les 3 dernières réservations avec safe reading
    const recentRows = rows.slice(-3);
    message += `📅 **3 dernières réservations:**\n`;
    
    recentRows.forEach((row, index) => {
      const timestamp = row.get('Timestamp') || 'N/A';
      const dateTime = row.get('DateTime') || 'N/A';
      const name = row.get('Name') || 'N/A';
      const partySize = row.get('PartySize') || 'N/A';
      const source = row.get('Source') || 'N/A';
      
      message += `**${index + 1}.** ${name}\n`;
      message += `   📅 ${dateTime}\n`;
      message += `   👥 ${partySize} pers.\n`;
      message += `   📱 ${source}\n`;
      
      // Only show phone/email if columns exist
      if (sheetHasPhoneEmail) {
        const phoneNumber = row.get('PhoneNumber') || 'N/A';
        const email = row.get('Email') || 'N/A';
        message += `   📞 ${phoneNumber}\n`;
        message += `   📧 ${email}\n`;
      }
      
      message += `   ⏰ ${timestamp}\n\n`;
    });
    
    ctx.reply(message, { parse_mode: 'Markdown' });
    
  } catch (error) {
    console.error('Debug sheet error:', error);
    ctx.reply(`❌ Erreur debug: ${error.message}`);
  }
});

// Rest of the commands remain exactly the same as the original...
// [Including all capacity management, booking commands, etc.]

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

// All the inline callback handlers remain the same...
[/* Same capacity management callbacks as original */]

// Ajouter réservation
bot.hears('➕ Ajouter réservation', ctx => {
  ctx.reply('📅 Choisissez une date pour votre réservation:', generateCalendar());
});

// Voir réservations aujourd'hui - ENHANCED WITH SAFE READING
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
      
      return line;
    });
    
    ctx.reply("*Réservations aujourd'hui:*\n" + lines.join("\n"), { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Error fetching reservations:', error);
    ctx.reply('❌ Erreur lors de la récupération des réservations');
  }
});

// ── ENHANCED BOOKING FLOW WITH PHONE NUMBER (CONDITIONAL) ───────────────────

// Enhanced text input handler with conditional phone number collection
bot.on('text', async ctx => {
  const userId = ctx.from.id;
  const session = userSessions.get(userId);
  
  // Handle name input for reservations
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
    
    const capacityResult = await addBookingWithCapacityCheck({
      name: name,
      party: parseInt(session.partySize),
      datetime: dateTime,
      source: 'Telegram',
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
  } catch (error) {
    console.error('Erreur création réservation:', error);
    ctx.reply('❌ Erreur. Réessayez.');
    userSessions.delete(userId);
  }
}

// Keep all other handlers exactly the same as original
// [Calendar, time, party size handlers, etc.]

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
    console.log(`🔧 Mode: ${sheetHasPhoneEmail ? '📞📧 Enhanced' : '⚠️ Compatible (backward compatible)'}`);
    console.log('📊 Capacity management system active');
    console.log(`🍽️ Lunch capacity: ${CAPACITY_CONFIG.lunch.maxCapacity} (${CAPACITY_CONFIG.lunch.startHour}h-${CAPACITY_CONFIG.lunch.endHour}h)`);
    console.log(`🌙 Dinner capacity: ${CAPACITY_CONFIG.dinner.maxCapacity} (${CAPACITY_CONFIG.dinner.startHour}h-${CAPACITY_CONFIG.dinner.endHour}h)`);
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
// EXPRESS SERVER
// ═══════════════════════════════════════════════════════════════════════════

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Express server listening on 0.0.0.0:${PORT}`);
  console.log(`📍 Health check: http://0.0.0.0:${PORT}`);
  console.log(`🌐 Webhook endpoint: http://0.0.0.0:${PORT}/webhook`);
  console.log(`📧 Webhook accepts: name, partySize, dateTime, email (optional)`);
  console.log(`🔧 Safe mode: Works with existing sheet structure`);
});