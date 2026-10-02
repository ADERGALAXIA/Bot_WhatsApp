const http = require('http');
const PORT = process.env.PORT || 3000;
const fs = require('fs'); // Importación de fs para el manejo de carpetas

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot DAI Pichincha Activo 24/7\n');
});

server.listen(PORT, () => {
    console.log(`Servidor HTTP escuchando en el puerto ${PORT}`);
});

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const QRCodeImage = require('qrcode');
const cron = require('node-cron');
const pino = require('pino');
const mysql = require('mysql2/promise');

// Credenciales de tu base de datos
const dbConfig = {
    host: '82.197.82.65', // Ej: tu IP de Hostinger
    user: 'u782494452_adertech',
    password: '1992moniK@',
    database: 'u782494452_Bot_whatsApp'
};

// Diccionario para almacenar las conexiones de ambos teléfonos en memoria
const sockets = {}; 

async function actualizarEstadoBD(id, estado, qr = '', telefono = 'Desconectado', grupo = 'Sincronizando grupos...') {
    try {
        const connection = await mysql.createConnection(dbConfig);
        await connection.execute(
            'UPDATE bot_estado SET estado = ?, qr_base64 = ?, telefono = ?, grupo_info = ? WHERE id = ?',
            [estado, qr, telefono, grupo, id]
        );
        await connection.end();
    } catch (error) {
        console.error(`Error actualizando estado de Línea ${id} en BD:`, error);
    }
}

async function iniciarBot(botId) {
    // Cada línea crea su propia carpeta de sesión para no interferir con la otra
    const { state, saveCreds } = await useMultiFileAuthState(`auth_bot_${botId}`);
    
    const sock = makeWASocket({ 
        auth: state, 
        printQRInTerminal: false, 
        logger: pino({ level: 'silent' }) 
    });

    // Guardamos el socket activo en el diccionario usando su ID (1 o 2)
    sockets[botId] = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            // Genera el QR en imagen y lo envía a la base de datos para mostrarlo en la web
            const qrBase64 = await QRCodeImage.toDataURL(qr);
            await actualizarEstadoBD(botId, 'Escanea el QR', qrBase64, 'Esperando conexión...', '-');
        }

        if (connection === 'close') {
            const razon = lastDisconnect.error?.output?.statusCode;
            
            if (razon !== DisconnectReason.loggedOut) {
                // Si fue un simple corte de internet, solo intenta reconectar
                await actualizarEstadoBD(botId, 'Reconectando...', '', 'Desconectado', '-');
                iniciarBot(botId);
            } else {
                // Si el usuario cerró sesión desde el celular (Deslogueado)
                await actualizarEstadoBD(botId, 'Deslogueado (Requiere QR)', '', 'Desconectado', '-');
                console.log(`Línea ${botId} desconectada manualmente. Borrando sesión local...`);
                
                // Borra la carpeta específica de esta línea
                fs.rmSync(`./auth_bot_${botId}`, { recursive: true, force: true }); 
                
                console.log(`Sesión auth_bot_${botId} borrada. Generando nuevo QR...`);
                iniciarBot(botId); // Llama a la función principal para que arranque de cero y cree el QR
            }
        } else if (connection === 'open') {
            // Extrae el número de teléfono del bot que acaba de conectar
            const numeroTel = '+' + sock.user.id.split(':')[0];
            await actualizarEstadoBD(botId, 'Conectado', '', numeroTel, 'Sincronizado');

            // --- FRAGMENTO INTEGRADO: Obtener y sincronizar grupos de esta línea ---
            console.log(`Línea ${botId} conectada correctamente.`);
            
            try {
                // Obtener todos los grupos donde participa este bot
                const grupos = await sock.groupFetchAllParticipating();
                
                const connectionDb = await mysql.createConnection(dbConfig);
                for (const jid in grupos) {
                    const grupo = grupos[jid];
                    // Guardar o actualizar el grupo en la base de datos asociado al id_bot
                    await connectionDb.execute(
                        `INSERT INTO bot_grupos (id_bot, grupo_jid, nombre_grupo) VALUES (?, ?, ?) 
                         ON DUPLICATE KEY UPDATE nombre_grupo = ?`,
                        [botId, jid, grupo.subject, grupo.subject]
                    );
                }
                await connectionDb.end();
                console.log(`Grupos de la Línea ${botId} sincronizados en MySQL con éxito.`);
            } catch (errGrupos) {
                console.error(`Error al sincronizar grupos de la Línea ${botId}:`, errGrupos);
            }
            // ---------------------------------------------------------------------
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;
        const texto = msg.message.conversation || msg.message.extendedTextMessage?.text;
        if (texto === '!id') console.log(`\nID capturado por Línea ${botId}: ${msg.key.remoteJid}`);
    });
}

// Orquestador Cron: Lee la base de datos y delega el mensaje al bot y grupo seleccionado
cron.schedule('* * * * *', async () => {
    try {
        const ahora = new Date().toLocaleTimeString("en-US", { timeZone: "America/Guayaquil", hour12: false, hour: "2-digit", minute: "2-digit" }) + ':00';
        
        const connection = await mysql.createConnection(dbConfig);
        const [rows] = await connection.execute('SELECT id, id_bot, grupo_jid, mensaje FROM programacion_mensajes WHERE hora_envio = ? AND estado = ?', [ahora, 'activo']);

        if (rows.length > 0) {
            for (const fila of rows) {
                const botRemitente = fila.id_bot;
                const destinoGrupo = fila.grupo_jid; // JID del grupo que se eligió en la web
                
                if (sockets[botRemitente]) {
                    try {
                        // ==========================================
                        // 📌 AQUÍ ES EXACTAMENTE DONDE VA ESA LÍNEA:
                        // ==========================================
                        await sockets[botRemitente].sendMessage(destinoGrupo, { text: fila.mensaje });
                        
                        console.log(`[${ahora}] Parte enviado exitosamente por la Línea ${botRemitente}`);
                        
                        await connection.execute("UPDATE programacion_mensajes SET ultimo_envio = CONVERT_TZ(NOW(), '+00:00', '-05:00'), estado_ultimo_envio = 'Enviado ✅' WHERE id = ?", [fila.id]);
                    } catch (errorEnvio) {
                        await connection.execute("UPDATE programacion_mensajes SET ultimo_envio = CONVERT_TZ(NOW(), '+00:00', '-05:00'), estado_ultimo_envio = 'Error al enviar ❌' WHERE id = ?", [fila.id]);
                    }
                } else {
                    await connection.execute("UPDATE programacion_mensajes SET ultimo_envio = CONVERT_TZ(NOW(), '+00:00', '-05:00'), estado_ultimo_envio = 'Línea Apagada ⚠️' WHERE id = ?", [fila.id]);
                }
            }
        }
        await connection.end();
    } catch (error) { 
        console.error('Error en el orquestador Cron:', error); 
    }
}, { timezone: "America/Guayaquil" });

// Arrancamos ambas instancias en paralelo
iniciarBot(1);
iniciarBot(2);
