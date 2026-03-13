export class LatencyTracer {
    private marks: Map<string, number> = new Map();
    private sessionId: string;

    constructor(sessionId: string) {
        this.sessionId = sessionId;
    }

    sttEnd() {
        this.marks.set('stt_end', performance.now());
    }

    llmFirstToken() {
        if (!this.marks.has('llm_first_token')) {
            this.marks.set('llm_first_token', performance.now());
        }
    }

    ttsFirstByte() {
        if (!this.marks.has('tts_first_byte')) {
            this.marks.set('tts_first_byte', performance.now());
        }
    }

    report(): { e2eMs: number; llmTtftMs: number; ttsTtfbMs: number } | null {
        const sttEnd = this.marks.get('stt_end');
        const llmFirst = this.marks.get('llm_first_token');
        const ttsFirst = this.marks.get('tts_first_byte');

        if (!sttEnd) return null;

        const e2eMs = ttsFirst ? ttsFirst - sttEnd : -1;
        const llmTtftMs = llmFirst ? llmFirst - sttEnd : -1;
        const ttsTtfbMs = (llmFirst && ttsFirst) ? ttsFirst - llmFirst : -1;

        console.log(
            `[LATENCY] Session ${this.sessionId.slice(0, 8)} | ` +
            `E2E: ${e2eMs >= 0 ? e2eMs.toFixed(0) + 'ms' : 'N/A'} | ` +
            `LLM TTFT: ${llmTtftMs >= 0 ? llmTtftMs.toFixed(0) + 'ms' : 'N/A'} | ` +
            `TTS TTFB: ${ttsTtfbMs >= 0 ? ttsTtfbMs.toFixed(0) + 'ms' : 'N/A'}`
        );

        return { e2eMs, llmTtftMs, ttsTtfbMs };
    }
}
