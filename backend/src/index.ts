import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyCors from '@fastify/cors';
import { config } from './config/env';
import { TranscriptionService } from './services/deepgram.service';
import { LLMService } from './services/llm.service';
import { TTSService } from './services/tts.service';
import { DataService } from './services/db.service';
import { LatencyTracer } from './services/latency.service';
import { CampaignService } from './services/campaign.service';
import crypto from 'crypto';

const fastify = Fastify({ logger: true });
fastify.register(fastifyWebsocket);
fastify.register(fastifyCors, { origin: true });

// --- Health check ---
fastify.get('/health', async () => {
    return { status: 'OK', message: 'Voice Agent API is running' };
});

// --- Campaign REST routes ---
fastify.post('/api/campaigns', async (req) => {
    const body = req.body as { name: string; type: string; targets: { patientId: number; appointmentId?: number }[] };
    const campaign = await CampaignService.createCampaign(body.name, body.type, body.targets);
    return { success: true, campaign };
});

fastify.post('/api/campaigns/:id/start', async (req) => {
    const { id } = req.params as { id: string };
    CampaignService.startCampaign(parseInt(id)).catch((err: unknown) => {
        console.error('Campaign error:', err);
    });
    return { success: true, message: 'Campaign started' };
});

fastify.get('/api/campaigns/:id/status', async (req) => {
    const { id } = req.params as { id: string };
    const status = await CampaignService.getCampaignStatus(parseInt(id));
    return status;
});

// --- WebSocket voice agent ---
fastify.register(async function (fastify) {
    fastify.get('/ws', { websocket: true }, (socket, req) => {
        const query = req.query as { lang?: string };
        const lang = (query.lang as 'en' | 'hi' | 'ta') || 'en';
        const sessionId = crypto.randomUUID();

        const transcriptionService = new TranscriptionService(lang);
        const llmService = new LLMService(lang);
        const ttsService = new TTSService(lang);

        let utteranceBuffer = "";
        let debounceTimer: NodeJS.Timeout | null = null;

        // Barge-in flags
        let isAiSpeaking = false;
        let interruptFlag = false;
        let ttsStartTime = 0;
        const BARGE_IN_COOLDOWN_MS = 1500; // ignore mic for 1.5s after TTS starts (avoids picking up AI's own voice)

        // Store language preference in session
        DataService.setSessionMeta(sessionId, { language: lang });

        transcriptionService.startStream((text, isFinal) => {
            socket.send(JSON.stringify({ type: 'transcript', text, isFinal }));

            // Barge-in: user speaks while AI is talking, but only after cooldown
            // (prevents AI's own TTS voice from being picked up by the mic)
            if (text.trim().length > 0 && isAiSpeaking && Date.now() - ttsStartTime > BARGE_IN_COOLDOWN_MS) {
                interruptFlag = true;
                socket.send(JSON.stringify({ type: 'interrupt' }));
                console.log("Barge-in detected! Interrupting AI.");
            }

            // Reset debounce on any speech
            if (text.trim().length > 0) {
                if (debounceTimer) {
                    clearTimeout(debounceTimer);
                    debounceTimer = null;
                }
            }

            if (isFinal && text.trim().length > 0) {
                utteranceBuffer += " " + text.trim();

                debounceTimer = setTimeout(async () => {
                    const fullSentence = utteranceBuffer.trim();
                    if (fullSentence.length === 0) return;
                    utteranceBuffer = "";

                    isAiSpeaking = true;
                    interruptFlag = false;

                    console.log('--- Triggering LLM with:', fullSentence);

                    // Latency tracking
                    const tracer = new LatencyTracer(sessionId);
                    tracer.sttEnd();

                    try {
                        let ttsBuffer = "";
                        let isFirstChunk = true;
                        let isFirstTTSByte = true;

                        await llmService.generateResponse(
                            sessionId,
                            fullSentence,
                            // onChunk: stream text to TTS
                            async (llmChunk) => {
                                if (interruptFlag) return;

                                if (isFirstChunk) {
                                    tracer.llmFirstToken();
                                    isFirstChunk = false;
                                }

                                socket.send(JSON.stringify({ type: 'llm_chunk', text: llmChunk }));
                                ttsBuffer += llmChunk;

                                // Split on sentence boundaries (including Hindi purna viram)
                                if (/[.!?\n।॥]/.test(llmChunk)) {
                                    const phraseToSpeak = ttsBuffer.trim();
                                    ttsBuffer = "";

                                    // Allow any non-whitespace content (fixes Hindi/Tamil bug)
                                    if (/\S/.test(phraseToSpeak)) {
                                        if (interruptFlag) return;

                                        await ttsService.streamSpeech(phraseToSpeak, (audioBuffer) => {
                                            if (!interruptFlag) {
                                                if (isFirstTTSByte) {
                                                    ttsStartTime = Date.now();
                                                    tracer.ttsFirstByte();
                                                    isFirstTTSByte = false;
                                                }
                                                socket.send(audioBuffer);
                                            }
                                        });
                                    }
                                }
                            },
                            // onToolAction: send reasoning trace to frontend
                            (toolAction) => {
                                socket.send(JSON.stringify({
                                    type: 'tool_action',
                                    tool: toolAction.tool,
                                    args: toolAction.args,
                                    result: toolAction.result,
                                    latencyMs: toolAction.latencyMs,
                                }));
                            },
                            // isInterrupted
                            () => interruptFlag,
                        );

                        // Speak final fragment
                        if (/\S/.test(ttsBuffer.trim()) && !interruptFlag) {
                            await ttsService.streamSpeech(ttsBuffer.trim(), (audioBuffer) => {
                                if (!interruptFlag) {
                                    if (isFirstTTSByte) {
                                        ttsStartTime = Date.now();
                                        tracer.ttsFirstByte();
                                        isFirstTTSByte = false;
                                    }
                                    socket.send(audioBuffer);
                                }
                            });
                        }

                        // Log latency and send to frontend
                        const latencyReport = tracer.report();
                        if (latencyReport) {
                            socket.send(JSON.stringify({
                                type: 'latency',
                                ...latencyReport,
                            }));
                        }

                    } catch (e) {
                        console.error("LLM Error:", e);
                    } finally {
                        isAiSpeaking = false;
                    }
                }, 1500);
            }
        });

        socket.on('message', (message: Buffer) => {
            transcriptionService.sendAudio(message);
        });

        socket.on('close', async () => {
            if (debounceTimer) clearTimeout(debounceTimer);
            transcriptionService.closeStream();
            ttsService.close();
            try {
                await DataService.archiveSession(sessionId);
            } catch (error) {
                console.error('Failed to archive session:', error);
            }
        });
    });
});

const start = async () => {
    try {
        await fastify.listen({ port: config.PORT });
        console.log(`Server listening on port ${config.PORT}`);
    } catch (err) {
        process.exit(1);
    }
};

start();
