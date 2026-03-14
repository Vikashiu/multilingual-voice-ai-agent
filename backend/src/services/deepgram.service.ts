import { createClient, LiveClient, LiveTranscriptionEvents } from '@deepgram/sdk';
import { config } from '../config/env';

const deepgram = createClient(config.DEEPGRAM_API_KEY);

const MAX_BUFFERED_CHUNKS = 200;
const INITIAL_RECONNECT_DELAY_MS = 500;
const MAX_RECONNECT_DELAY_MS = 5000;

export class TranscriptionService {
    private liveClient: LiveClient | null = null;
    private isReady = false;
    private chunkBuffer: Buffer[] = [];
    private lang: string;
    private onTranscript?: (text: string, isFinal: boolean, speechFinal: boolean) => void;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
    private manuallyClosed = false;

    constructor(lang: string = 'en') {
        this.lang = lang;
    }

    private clearReconnectTimer() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    private flushBufferedAudio() {
        if (!this.liveClient || !this.isReady || this.chunkBuffer.length === 0) {
            return;
        }

        console.log(`Flushing ${this.chunkBuffer.length} buffered chunks to Deepgram...`);
        for (const chunk of this.chunkBuffer) {
            this.liveClient.send(chunk as any);
        }
        this.chunkBuffer = [];
    }

    private scheduleReconnect() {
        if (this.manuallyClosed || this.reconnectTimer || !this.onTranscript) {
            return;
        }

        const delay = this.reconnectDelayMs;
        console.warn(`Deepgram disconnected. Reconnecting in ${delay}ms...`);

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            void this.connect();
        }, delay);

        this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
    }

    private async connect() {
        if (this.manuallyClosed || !this.onTranscript) {
            return;
        }

        try {
            this.clearReconnectTimer();

            this.liveClient = deepgram.listen.live({
                model: 'nova-2',
                language: this.lang,
                smart_format: true,
                interim_results: true,
                endpointing: 120,
            });

            this.liveClient.addListener(LiveTranscriptionEvents.Open, () => {
                console.log('Deepgram connection established.');
                this.isReady = true;
                this.reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
                this.flushBufferedAudio();
            });

            this.liveClient.addListener(LiveTranscriptionEvents.Close, (event) => {
                console.log('Deepgram connection closed.', event);
                this.isReady = false;
                this.liveClient = null;
                this.scheduleReconnect();
            });

            this.liveClient.addListener(LiveTranscriptionEvents.Transcript, (data) => {
                const transcript = data.channel.alternatives[0].transcript;
                if (transcript && this.onTranscript) {
                    this.onTranscript(transcript, data.is_final, data.speech_final);
                }
            });

            this.liveClient.addListener(LiveTranscriptionEvents.Error, (error) => {
                console.error('Deepgram error:', error);
                this.isReady = false;
                this.liveClient = null;
                this.scheduleReconnect();
            });
        } catch (error) {
            console.error('Failed to initialize Deepgram stream:', error);
            this.isReady = false;
            this.liveClient = null;
            this.scheduleReconnect();
        }
    }

    public startStream(onTranscript: (text: string, isFinal: boolean, speechFinal: boolean) => void) {
        this.onTranscript = onTranscript;
        this.manuallyClosed = false;
        void this.connect();
    }

    public sendAudio(audioBuffer: Buffer) {
        if (this.isReady && this.liveClient) {
            this.liveClient.send(audioBuffer as any);
            return;
        }

        if (this.chunkBuffer.length >= MAX_BUFFERED_CHUNKS) {
            this.chunkBuffer.shift();
        }

        this.chunkBuffer.push(audioBuffer);
        console.log(`Buffered chunk (${audioBuffer.length} bytes) - Waiting for Deepgram...`);

        if (!this.liveClient && !this.manuallyClosed) {
            this.scheduleReconnect();
        }
    }

    public closeStream() {
        this.manuallyClosed = true;
        this.isReady = false;
        this.clearReconnectTimer();
        this.chunkBuffer = [];

        if (this.liveClient) {
            try {
                this.liveClient.requestClose();
            } catch {
                // ignore close failures during shutdown
            }
            this.liveClient = null;
        }
    }
}
