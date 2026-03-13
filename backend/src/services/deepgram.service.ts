import { createClient, LiveClient, LiveTranscriptionEvents } from '@deepgram/sdk';
import { config } from '../config/env';

const deepgram = createClient(config.DEEPGRAM_API_KEY);

export class TranscriptionService {
    private liveClient: LiveClient | null = null;
    private isReady: boolean = false;
    private chunkBuffer: Buffer[] = []; // Store early chunks here!
    private lang: string;

    constructor(lang: string = 'en'){
        this.lang=lang;
    }

    public startStream(onTranscript: (text: string, isFinal: boolean) => void) {
        this.liveClient = deepgram.listen.live({
            model: 'nova-2',
            language: this.lang,
            smart_format: true,
            interim_results: true,
        });

        this.liveClient.addListener(LiveTranscriptionEvents.Open, () => {
            console.log('✅ Deepgram connection established!');
            this.isReady = true;

            // Immediately flush any chunks we saved while waiting!
            if (this.chunkBuffer.length > 0) {
                console.log(`🚀 Flushing ${this.chunkBuffer.length} buffered chunks to Deepgram...`);
                for (const chunk of this.chunkBuffer) {
                    this.liveClient?.send(chunk as any);
                }
                this.chunkBuffer = []; // Clear the buffer
            }
        });

        this.liveClient.addListener(LiveTranscriptionEvents.Close, (event) => {
            console.log('❌ Deepgram connection closed!', event);
            this.isReady = false;
        });

        this.liveClient.addListener(LiveTranscriptionEvents.Transcript, (data) => {
            const transcript = data.channel.alternatives[0].transcript;
            if (transcript) {
                onTranscript(transcript, data.is_final);
            }
        });

        this.liveClient.addListener(LiveTranscriptionEvents.Error, (error) => {
            console.error('⚠️ Deepgram Error:', error);
        });
    }

    public sendAudio(audioBuffer: Buffer) {
        if (this.isReady && this.liveClient) {
            this.liveClient.send(audioBuffer as any);
        } else {
            // Buffer the chunks instead of dropping them!
            this.chunkBuffer.push(audioBuffer);
            console.log(`📦 Buffered chunk (${audioBuffer.length} bytes) - Waiting for Deepgram...`);
        }
    }

    public closeStream() {
        if (this.liveClient) {
            this.liveClient.requestClose();
            this.liveClient = null;
            this.isReady = false;
        }
    }
}