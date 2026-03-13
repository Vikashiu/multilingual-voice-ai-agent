import Cartesia from "@cartesia/cartesia-js";
import { config } from "../config/env";
import crypto from "crypto";

export class TTSService {
    private cartesia: Cartesia;
    private langCode: string;
    private currentVoiceId: string;
    private ws: any = null;
    private pendingContexts = new Map<string, { onAudio: (buffer: Buffer) => void; resolve: () => void }>();

    constructor(langCode: 'en' | 'hi' | 'ta' = 'en') {
        this.langCode = langCode;
        this.currentVoiceId = config.VOICES[langCode] || config.VOICES['en'];
        this.cartesia = new Cartesia({
            apiKey: config.CARTESIA_API_KEY,
        });
    }

    private async ensureConnection(): Promise<void> {
        if (this.ws) return;

        const ws = await this.cartesia.tts.websocket({
            container: "raw",
            encoding: "pcm_s16le",
            sampleRate: 16000,
        });

        await ws.connect();

        ws.on("chunk", (message: any) => {
            // Try to route by context_id first
            let ctx = this.pendingContexts.get(message.context_id);

            // Fallback: if SDK doesn't echo context_id, route to the only pending request
            if (!ctx && this.pendingContexts.size === 1) {
                ctx = this.pendingContexts.values().next().value;
            }

            if (!ctx) return;

            if (message.audio) {
                const audioBuffer = typeof message.audio === 'string'
                    ? Buffer.from(message.audio, 'base64')
                    : Buffer.from(message.audio as Uint8Array);
                ctx.onAudio(audioBuffer);
            }

            if (message.done) {
                // Delete by context_id if available, otherwise clear the single entry
                if (message.context_id && this.pendingContexts.has(message.context_id)) {
                    this.pendingContexts.delete(message.context_id);
                } else if (this.pendingContexts.size === 1) {
                    this.pendingContexts.clear();
                }
                ctx.resolve();
            }
        });

        ws.on("error", (err: any) => {
            console.error("Cartesia WebSocket Error:", err);
            for (const [, ctx] of this.pendingContexts) {
                ctx.resolve();
            }
            this.pendingContexts.clear();
            this.ws = null;
        });

        this.ws = ws;
    }

    public streamSpeech(text: string, onAudio: (buffer: Buffer) => void): Promise<void> {
        return new Promise(async (resolve) => {
            try {
                await this.ensureConnection();
                const contextId = crypto.randomUUID();

                this.pendingContexts.set(contextId, { onAudio, resolve });

                this.ws.send({
                    model_id: "sonic-multilingual",
                    language: this.langCode,
                    voice: {
                        mode: "id",
                        id: this.currentVoiceId,
                    },
                    output_format: {
                        container: "raw",
                        encoding: "pcm_s16le",
                        sample_rate: 16000,
                    },
                    context_id: contextId,
                    transcript: text,
                });

            } catch (error) {
                console.error("TTS Setup Error:", error);
                this.ws = null;
                resolve();
            }
        });
    }

    public close() {
        for (const [, ctx] of this.pendingContexts) {
            ctx.resolve();
        }
        this.pendingContexts.clear();
        if (this.ws) {
            try { this.ws.disconnect(); } catch (e) { }
            this.ws = null;
        }
    }
}
