/* index.js - PRODUCTION READY VERSION
 * Telegram Booking Bot using Google Sheets + Google Calendar
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
const SHEET_ID = process.env.SHEET_ID || '1GH8zQTwVWUSwzX01V2BIIVMr940uob4ph-GeoT2zYtU';
const PORT = process.env.PORT || 3000;

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
  service: 'La Savane Booking Bot',
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

// Initialize Google Sheets and Calendar
async function initializeGoogleServices() {
  try {
    console.log('🔄 Initializing Google Services...');
    
    // Use environment variable for credentials in production
    let credentials;
    if (process.env.GOOGLE_CREDENTIALS) {
      credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
    } else {
      // Fallback to file for local development
      credentials = JSON.parse(
        await readFile(new URL('./credentials.json', import.meta.url))
      );
    }
    
    console.log('✅ Credentials loaded, creating JWT...');
    
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
    
    // Initialize Google Calendar
    calendar = google.calendar({ version: 'v3', auth: serviceAccountAuth });
    
    console.log('✅ Google Services initialized successfully');
    console.log(`📊 Connected to sheet: ${doc.title}`);
    console.log(`📋 Sheet name: ${sheet.title}`);
  } catch (error) {
    console.error('❌ Failed to initialize Google Services:', error);
    console.error('Error details:', error.message);
    process.exit(1);
  }
}

// FIXED: Add booking without attendees to avoid permission issues
async function addBooking({ name, party, datetime, source }) {
  if (!sheet || !calendar) {
    throw new Error('Google Services not initialized');
  }
  
  console.log(`📝 Adding booking: ${name}, ${party} people, ${datetime}, via ${source}`);
  
  // Add to Google Sheets
  await sheet.addRow({
    Timestamp: new Date().toISOString(),
    Name: name,
    Party: party,
    DateTime: datetime,
    Source: source
  });

  // Add to Google Calendar - FIXED: No attendees
  try {
    const startDate = new Date(datetime);
    const endDate = new Date(startDate.getTime() + (2 * 60 * 60 * 1000)); // 2 hours duration
    
    const event = {
      summary: `Réservation: ${name} (${party} pers.)`,
      description: `Réservation pour ${party} personne(s)\nNom: ${name}\nSource: ${source}\n\n📞 Contact: ${name}`,
      start: {
        dateTime: startDate.toISOString(),
        timeZone: 'Europe/Paris',
      },
      end: {
        dateTime: endDate.toISOString(),
        timeZone: 'Europe/Paris',
      },
      // REMOVED attendees to fix permission error
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

// IMPROVED: Webflow webhook with better error handling
app.post('/webhook', async (req, res) => {
  try {
    console.log('📲 Webhook received:', req.body);
    
    const { name, partySize, dateTime } = req.body;
    
    // Validate required fields
    if (!name || !partySize || !dateTime) {
      console.error('❌ Missing required fields:', { name, partySize, dateTime });
      return res.status(400).json({ error: 'Missing required fields: name, partySize, dateTime' });
    }
    
    // Convert to ISO string for consistent storage
    const when = new Date(dateTime).toISOString();
    
    // Validate the date is valid
    if (isNaN(new Date(when).getTime())) {
      console.error('❌ Invalid date format:', dateTime);
      return res.status(400).json({ error: 'Invalid date format' });
    }
    
    console.log('✅ Processing reservation:', { name, party: partySize, datetime: when, source: 'Webflow' });
    
    // Add to sheets and calendar
    await addBooking({ 
      name, 
      party: parseInt(partySize), 
      datetime: when, 
      source: 'Webflow' 
    });
    
    // Send Telegram notification
    const dateDisplay = new Date(when).toLocaleDateString('fr-FR', { 
      weekday: 'long', 
      day: 'numeric', 
      month: 'long',
      hour: '2-digit',
      minute: '2-digit'
    });
    
    await notifyTelegram(
      `📲 *Nouvelle réservation web*\n• ${dateDisplay}\n• ${partySize} personne(s): ${name}`
    );
    
    console.log('✅ Reservation processed successfully');
    res.status(200).json({ 
      success: true, 
      message: 'Reservation created successfully',
      reservation: { name, partySize, dateTime: when }
    });
    
  } catch (err) {
    console.error('❌ Webhook error:', err);
    res.status(500).json({ 
      error: 'Internal server error', 
      details: err.message 
    });
  }
});

// Reply keyboard with buttons
const mainKeyboard = Markup.keyboard([
  ['➕ Ajouter réservation', "📋 Voir réservations aujourd'hui"],
  ['📅 Voir calendrier', '📊 Voir resa de la semaine']
]).resize();

// /start
bot.start(ctx =>
  ctx.reply('Bienvenue chez La Savane! Choisissez une action:', mainKeyboard)
);

// Ajouter réservation
bot.hears('➕ Ajouter réservation', ctx => {
  ctx.reply('📅 Choisissez une date pour votre réservation:', generateCalendar());
});

// Voir réservations aujourd'hui
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
      const party = r.get('Party');
      return `– ${t}, ${party}-personnes: ${name}`;
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
    
    ctx.reply(`✅ Réservation ajoutée : ${date} ${time}, ${party}-personnes pour ${name}`);
    await notifyTelegram(
      `📞 *Réservation téléphone*\n• ${date} ${time}\n• ${party}-personnes: ${name}`
    );
  } catch (error) {
    console.error('Error adding reservation:', error);
    ctx.reply('❌ Erreur lors de l\'ajout de la réservation');
  }
});

// /list
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
      const party = r.get('Party');
      return `– ${t}, ${party}-personnes: ${name}`;
    });
    
    ctx.reply("*Réservations aujourd'hui:*\n" + lines.join("\n"), { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Error listing reservations:', error);
    ctx.reply('❌ Erreur lors de la récupération des réservations');
  }
});

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

// Handle name input
bot.on('text', async ctx => {
  const userId = ctx.from.id;
  const session = userSessions.get(userId);
  
  if (session && session.waitingForName) {
    const name = ctx.message.text;
    
    try {
      const dateTime = `${session.selectedDate}T${session.selectedTime}:00`;
      console.log('DEBUG: Saving reservation:', { 
        selectedDate: session.selectedDate, 
        selectedTime: session.selectedTime, 
        dateTime, 
        today: getTodayString() 
      });
      
      await addBooking({
        name,
        party: parseInt(session.partySize),
        datetime: dateTime,
        source: 'Phone'
      });
      
      console.log('✅ Reservation saved successfully');
      
      userSessions.delete(userId);
      
      const dateObj = new Date(session.selectedDate);
      const dateDisplay = dateObj.toLocaleDateString('fr-FR', { 
        weekday: 'long', 
        day: 'numeric', 
        month: 'long'
      });
      
      ctx.reply(
        `✅ *Réservation confirmée!*\n\n` +
        `📅 Date: ${dateDisplay}\n` +
        `🕐 Heure: ${session.selectedTime}\n` +
        `👥 Personnes: ${session.partySize}\n` +
        `📝 Nom: ${name}\n\n` +
        `✨ Ajoutée au calendrier et aux feuilles de calcul! 🍽️`,
        { parse_mode: 'Markdown', ...mainKeyboard }
      );
      
      await notifyTelegram(
        `📞 *Nouvelle réservation téléphone*\n• ${dateDisplay} ${session.selectedTime}\n• ${session.partySize}-personnes: ${name}`
      );
      
    } catch (error) {
      console.error('Error creating reservation:', error);
      ctx.reply('❌ Erreur lors de la création de la réservation. Veuillez réessayer.');
      userSessions.delete(userId);
    }
  }
});

// Error handling for bot
bot.catch((err, ctx) => {
  console.error('Bot error:', err);
});

// Initialize and start the application
async function startApp() {
  try {
    await initializeGoogleServices();
    
    // Launch bot
    await bot.launch();
    console.log('🤖 Telegram bot started successfully');
    
    // Start Express server
    app.listen(PORT, () => {
      console.log(`🚀 Express server listening on port ${PORT}`);
      console.log(`📍 Health check: http://localhost:${PORT}`);
    });
    
  } catch (error) {
    console.error('❌ Failed to start application:', error);
    process.exit(1);
  }
}

// Shutdown handlers
process.once('SIGINT', () => {
  console.log('Received SIGINT, stopping bot...');
  bot.stop('SIGINT');
});

process.once('SIGTERM', () => {
  console.log('Received SIGTERM, stopping bot...');
  bot.stop('SIGTERM');
});

// Start the application
startApp();