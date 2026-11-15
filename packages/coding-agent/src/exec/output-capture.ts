/**
 * The output side of a command run: terminal-graphics extraction, the truncating/artifact-spilling
 * {@link OutputSink}, and the final summary. Shared by every way a command can run (the embedded
 * shell, a PTY, an exec backend) so each one truncates and spills the same way.
 */
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { OutputSink, type OutputSummary } from "@oh-my-pi/pi-tui/tools/streaming-output";
import type { Settings } from "../config/settings";
import {
	resolveOutputMaxColumns,
	resolveOutputSinkArtifactMaxBytes,
	resolveOutputSinkHeadBytes,
} from "../tools/output-meta";
import { TerminalGraphicsDecoder } from "../utils/terminal-graphics";

export interface OutputCaptureOptions {
	/** Receives each chunk as the sink emits it (throttled). */
	onChunk?: (chunk: string) => void;
	/** Receives the sink's inline preview at the `onChunk` cadence. */
	onPreview?: (text: string) => void;
	chunkThrottleMs?: number;
	/** Artifact path/id for full output storage. */
	artifactPath?: string;
	artifactId?: string;
}

export type OutputCaptureSummary = OutputSummary & { images?: ImageContent[] };

export interface OutputCapture {
	sink: OutputSink;
	graphics: TerminalGraphicsDecoder;
	/** Feed raw output; ignored after {@link stopAccepting}. */
	enqueueChunk(chunk: string): void;
	/** Drop output that arrives from now on (a cancelled or timed-out run that may still write). */
	stopAccepting(): void;
	/** Flush the decoder and sink and summarize; `notice` is appended to the output. */
	dump(notice?: string): Promise<OutputCaptureSummary>;
}

export function createOutputCapture(settings: Settings, options: OutputCaptureOptions | undefined): OutputCapture {
	const graphics = new TerminalGraphicsDecoder();
	const { onChunk, onPreview } = options ?? {};
	const sink: OutputSink = new OutputSink({
		onChunk:
			onChunk || onPreview
				? chunk => {
						onChunk?.(chunk);
						onPreview?.(sink.preview());
					}
				: undefined,
		artifactPath: options?.artifactPath,
		artifactId: options?.artifactId,
		headBytes: resolveOutputSinkHeadBytes(settings),
		artifactMaxBytes: resolveOutputSinkArtifactMaxBytes(settings),
		maxColumns: resolveOutputMaxColumns(settings),
		chunkThrottleMs: onChunk || onPreview ? (options?.chunkThrottleMs ?? 50) : 0,
	});

	// sink.push() is synchronous — buffer management, counters, and onChunk
	// all run inline. File writes (artifact path) are handled asynchronously
	// inside the sink. No promise chain needed.
	let acceptingChunks = true;
	let graphicsFinished = false;
	let decodedImages: ImageContent[] = [];
	return {
		sink,
		graphics,
		enqueueChunk(chunk: string): void {
			if (!acceptingChunks) return;
			const clean = graphics.push(chunk);
			if (clean) sink.push(clean);
		},
		stopAccepting(): void {
			acceptingChunks = false;
		},
		async dump(notice?: string): Promise<OutputCaptureSummary> {
			if (!graphicsFinished) {
				graphicsFinished = true;
				const tail = graphics.finish();
				if (tail) sink.push(tail);
				decodedImages = await graphics.images();
			}
			return {
				...(await sink.dump(notice)),
				...(decodedImages.length > 0 ? { images: decodedImages } : {}),
			};
		},
	};
}
