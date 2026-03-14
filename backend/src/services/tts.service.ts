import Cartesia from '@cartesia/cartesia-js';
import { config } from '../config/env';
import crypto from 'crypto';

export class TTSService {
    private cartesia: Cartesia;
    private langCode: string;
    private currentVoiceId: string;
    private activeSockets = new Set<any>();

    constructor(langCode: 'en' | 'hi' | 'ta' = 'en') {
        this.langCode = langCode;
        this.currentVoiceId = config.VOICES[langCode] || config.VOICES.en;
        this.cartesia = new Cartesia({
            apiKey: config.CARTESIA_API_KEY,
        });
    }

    public streamSpeech(text: string, onAudio: (buffer: Buffer) => void): Promise<void> {
        return new Promise(async (resolve) => {
            let ws: any = null;
            let settled = false;
            let idleTimer: NodeJS.Timeout | null = null;
            let hardTimeout: NodeJS.Timeout | null = null;

            const clearTimers = () => {
                if (idleTimer) clearTimeout(idleTimer);
                if (hardTimeout) clearTimeout(hardTimeout);
                idleTimer = null;
                hardTimeout = null;
            };

            const finish = () => {
                if (settled) return;
                settled = true;
                clearTimers();

                if (ws) {
                    this.activeSockets.delete(ws);
                    try {
                        ws.disconnect();
                    } catch {
                        // ignore disconnect failures during cleanup
                    }
                }

                resolve();
            };

            const armIdleTimeout = () => {
                if (idleTimer) clearTimeout(idleTimer);
                idleTimer = setTimeout(() => {
                    finish();
                }, 400);
            };

            try {
                ws = await this.cartesia.tts.websocket({
                    container: 'raw',
                    encoding: 'pcm_s16le',
                    sampleRate: 16000,
                });

                this.activeSockets.add(ws);
                await ws.connect();

                ws.on('chunk', (message: any) => {
                    if (message.audio) {
                        const audioBuffer = typeof message.audio === 'string'
                            ? Buffer.from(message.audio, 'base64')
                            : Buffer.from(message.audio as Uint8Array);
                        onAudio(audioBuffer);
                        armIdleTimeout();
                    }

                    if (message.done) {
                        finish();
                    }
                });

                ws.on('error', (err: any) => {
                    console.error('Cartesia WebSocket Error:', err);
                    finish();
                });

                hardTimeout = setTimeout(() => {
                    finish();
                }, 15000);

                ws.send({
                    model_id: 'sonic-multilingual',
                    language: this.langCode,
                    voice: {
                        mode: 'id',
                        id: this.currentVoiceId,
                    },
                    output_format: {
                        container: 'raw',
                        encoding: 'pcm_s16le',
                        sample_rate: 16000,
                    },
                    context_id: crypto.randomUUID(),
                    transcript: text,
                });

                armIdleTimeout();
            } catch (error) {
                console.error('TTS Setup Error:', error);
                finish();
            }
        });
    }

    public close() {
        for (const ws of this.activeSockets) {
            try {
                ws.disconnect();
            } catch {
                // ignore cleanup failures
            }
        }
        this.activeSockets.clear();
    }
}
