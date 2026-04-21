const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const qrcode = require('qrcode');
const fs = require('fs-extra');
const path = require('path');
const cors = require('cors');

const PORT = 8790;
const SESSION_DIR = path.join(__dirname, '.wwebjs_auth');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, {
    maxHttpBufferSize: 1e8, // 100 MB
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

let client = null;
let isConnected = false;
let qrCode = null;
let isInitializing = false;

async function startWhatsApp() {
    if (isInitializing) {
        console.log('WhatsApp is already initializing...');
        return;
    }
    isInitializing = true;

    // --- CLEANUP PREVIOUS CLIENT ---
    if (client) {
        console.log('Cleaning up previous connection...');
        try {
            await client.destroy();
        } catch (e) {
            console.error('Cleanup error:', e.message);
        }
        client = null;
    }

    client = new Client({
        authStrategy: new LocalAuth({
            dataPath: SESSION_DIR
        }),
        puppeteer: {
            executablePath: 'C:\\Users\\Kunal\\.cache\\puppeteer\\chrome\\win64-147.0.7727.57\\chrome-win64\\chrome.exe',
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu',
                '--disable-extensions',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding',
                '--js-flags="--max-old-space-size=2048"' // Give more memory to browser JS
            ]
        }
    });

    client.on('qr', async (qr) => {
        isConnected = false;
        isInitializing = false;
        qrCode = await qrcode.toDataURL(qr);
        io.emit('qr', { qr: qrCode });
        console.log('New QR code generated');
    });

    client.on('ready', async () => {
        isConnected = true;
        isInitializing = false;
        qrCode = null;
        console.log('✅ WhatsApp Connected!');

        // Increase timeouts for media handling
        try {
            const page = client.pupPage;
            if (page) {
                await page.setDefaultTimeout(60000); 
                await page.setDefaultNavigationTimeout(60000);
            }
        } catch (e) {
            console.error('Timeout setup error:', e.message);
        }

        io.emit('status', { 
            connected: true, 
            user: {
                id: client.info.wid._serialized,
                name: client.info.pushname || 'WhatsApp User'
            } 
        });
    });

    client.on('authenticated', () => {
        console.log('AUTHENTICATED');
    });

    client.on('auth_failure', msg => {
        console.error('AUTHENTICATION FAILURE', msg);
        io.emit('status', { connected: false, reason: msg });
    });

    client.on('disconnected', (reason) => {
        isConnected = false;
        isInitializing = false;
        qrCode = null;
        console.log('Client was logged out', reason);
        io.emit('status', { connected: false, reason: reason });
        // Attempt to re-initialize for new QR
        setTimeout(startWhatsApp, 2000);
    });

    client.initialize().catch(err => {
        console.error('Initialization error:', err.message);
        isInitializing = false;
    });
}

async function logout() {
    isInitializing = false;
    try {
        if (client) {
            await client.logout();
            await client.destroy();
        }
    } catch (e) {}
    
    // session folder will be handled by wwebjs logout usually, but we force clean
    if (fs.existsSync(SESSION_DIR)) {
        await fs.remove(SESSION_DIR);
    }
    
    client = null;
    isConnected = false;
    qrCode = null;
    io.emit('status', { connected: false });
    console.log('Logged out and auth files deleted.');
    startWhatsApp(); 
}

// Broadcast State
let activeBroadcast = null;

io.on('connection', (socket) => {
    console.log('New client connected');
    
    // Send initial status
    socket.emit('status', { 
        connected: isConnected, 
        user: isConnected && client?.info ? {
            id: client.info.wid._serialized,
            name: client.info.pushname || 'WhatsApp User'
        } : null 
    });
    if (qrCode) {
        socket.emit('qr', { qr: qrCode });
    }

    socket.on('logout', async () => {
        await logout();
    });

    socket.on('start_broadcast', async (data) => {
        const { numbers, message, delay, media, document: doc } = data;
        
        console.log('--- START BROADCAST EVENT RECEIVED ---');
        console.log(`Contacts: ${numbers?.length}, Delay: ${delay?.min}-${delay?.max}s`);

        if (!isConnected || !client) {
            console.log('Broadcast failed: WhatsApp not connected');
            return socket.emit('broadcast_status', { message: '❌ Error: WhatsApp not connected. Please go to "Connect" tab.', done: true });
        }

        if (!numbers || numbers.length === 0) {
            return socket.emit('broadcast_status', { message: '❌ Error: No numbers provided.', done: true });
        }

        activeBroadcast = {
            stopped: false,
            paused: false,
            current: 0,
            total: numbers.length
        };

        socket.emit('broadcast_status', { message: `🚀 Campaign started for ${numbers.length} contacts.` });

        // Wait a small moment to ensure everything is initialized
        await new Promise(resolve => setTimeout(resolve, 1000));

        for (let i = 0; i < numbers.length; i++) {
            if (activeBroadcast.stopped) {
                console.log('Broadcast stopped by user.');
                break;
            }
            
            while (activeBroadcast.paused) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                if (activeBroadcast.stopped) break;
            }

            const number = numbers[i].replace(/\D/g, '');
            const jid = `${number}@c.us`;
            
            socket.emit('broadcast_status', { message: `⏳ Processing contact ${i + 1}/${numbers.length}: ${numbers[i]}` });

            try {
                // Priority 1: Media (Image/Video) with Caption
                if (media && media.data) {
                    console.log(`📸 Sending media: ${media.name} (${media.type}) to ${numbers[i]}`);
                    const base64Data = media.data.split(",")[1];
                    const msgMedia = new MessageMedia(media.type, base64Data, media.name || 'image');
                    await client.sendMessage(jid, msgMedia, { caption: message });
                } 
                // Priority 2: Text only (if no media)
                else if (message) {
                    await client.sendMessage(jid, message);
                }

                // Priority 3: Separate Document (sent after media/text)
                if (doc && doc.data) {
                    const docBase64 = doc.data.split(",")[1];
                    const docMedia = new MessageMedia(doc.type, docBase64, doc.name);
                    await client.sendMessage(jid, docMedia);
                }
                
                socket.emit('broadcast_status', { 
                    number: numbers[i], 
                    status: 'success', 
                    current: i + 1,
                    total: numbers.length,
                    message: `✅ Delivered to ${numbers[i]}`
                });
            } catch (err) {
                console.error(`Failed for ${numbers[i]}:`, err.message);
                socket.emit('broadcast_status', { 
                    number: numbers[i], 
                    status: 'error', 
                    current: i + 1,
                    total: numbers.length,
                    message: `❌ Failed for ${numbers[i]}: ${err.message}`
                });
            }

            // Random delay between messages
            if (i < numbers.length - 1 && !activeBroadcast.stopped) {
                const min = parseInt(delay.min) || 1;
                const max = parseInt(delay.max) || 8;
                const waitTime = Math.floor(Math.random() * (max - min + 1) + min) * 1000;
                
                socket.emit('broadcast_status', { message: `⏸️ Cooling down for ${waitTime/1000}s...` });
                await new Promise(resolve => setTimeout(resolve, waitTime));
            }
        }

        const completionMsg = activeBroadcast.stopped ? 'Campaign stopped.' : '🎉 Campaign completed successfully!';
        socket.emit('broadcast_status', { message: completionMsg, done: true });
        activeBroadcast = null;
    });

    socket.on('stop_broadcast', () => {
        if (activeBroadcast) {
            activeBroadcast.stopped = true;
            socket.emit('broadcast_status', { message: 'Broadcast stopped by user', done: true });
        }
    });

    socket.on('refresh_qr', () => {
        console.log('Manual QR refresh requested.');
        startWhatsApp();
    });

    socket.on('pause_broadcast', (paused) => {
        if (activeBroadcast) {
            activeBroadcast.paused = paused;
            socket.emit('broadcast_status', { message: paused ? 'Broadcast paused' : 'Broadcast resumed' });
        }
    });
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', connected: isConnected });
});

// Root route for development helper
app.get('/', (req, res) => {
    res.send(`
        <div style="font-family: sans-serif; text-align: center; margin-top: 50px; background: #0f172a; color: white; min-height: 100vh; padding-top: 50px;">
            <h1 style="color: #25D366;">WhatsApp Dashboard API (wwebjs)</h1>
            <p>The backend server is running successfully on port ${PORT}.</p>
            <div style="background: #1e293b; padding: 20px; border-radius: 10px; display: inline-block; margin-top: 20px; border: 1px solid #334155;">
                <p>To see the Dashboard UI, please run:</p>
                <code style="background: black; padding: 5px 10px; border-radius: 5px; color: #fbbf24;">npm run dev-client</code>
                <p>in a separate terminal and open <a href="http://localhost:5173" style="color: #60a5fa;">http://localhost:5173</a></p>
            </div>
        </div>
    `);
});

// Serve static files from React app in production
if (process.env.NODE_ENV === 'production') {
    app.use(express.static(path.join(__dirname, '../client/dist')));
    app.get('*', (req, res) => {
        res.sendFile(path.join(__dirname, '../client/dist/index.html'));
    });
}

server.listen(PORT, () => {
    console.log(`\n===========================================`);
    console.log(`🚀 SERVER RUNNING: http://localhost:${PORT}`);
    console.log(`🔗 DASHBOARD UI:  http://localhost:5173`);
    console.log(`===========================================\n`);
    startWhatsApp();
});

