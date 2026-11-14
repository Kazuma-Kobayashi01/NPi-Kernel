/**
 * Who besides the terminal may answer a dialog: collab guests ({@link CollabHost}) and the phone following
 * the session over `/rc` ({@link RemoteControl}). Each is offered the same request; the first answer wins
 * and withdraws it from the others.
 */
import type { CollabUiRequestDraft } from "@oh-my-pi/pi-wire";
import type { CollabGuestUiResult } from "../../collab/host";

export interface GuestUiPeer {
	/**
	 * Offer `request`; null when this peer cannot take it now. Settles `unavailable` (never a cancel) when the
	 * peer goes away or `signal` aborts first.
	 */
	requestGuestUi(
		request: CollabUiRequestDraft,
		signal?: AbortSignal,
		options?: { retainOnReconnect?: boolean },
	): Promise<CollabGuestUiResult> | null;
}

/** One peer standing for all of `peers` that are present, or undefined when there are none. */
export function combineGuestUiPeers(peers: ReadonlyArray<GuestUiPeer | undefined>): GuestUiPeer | undefined {
	const present = peers.filter((peer): peer is GuestUiPeer => peer !== undefined);
	if (present.length <= 1) return present[0];
	return {
		requestGuestUi(request, signal, options) {
			const offers: Array<{ result: Promise<CollabGuestUiResult>; abort: AbortController }> = [];
			for (const peer of present) {
				const abort = new AbortController();
				const result = peer.requestGuestUi(
					request,
					signal ? AbortSignal.any([signal, abort.signal]) : abort.signal,
					options,
				);
				if (result) offers.push({ result, abort });
			}
			if (offers.length === 0) return null;
			if (offers.length === 1) return offers[0]!.result;
			const { promise, resolve } = Promise.withResolvers<CollabGuestUiResult>();
			let open = offers.length;
			for (const offer of offers) {
				void offer.result.then(result => {
					open--;
					if (result.kind === "answered") {
						for (const other of offers) if (other !== offer) other.abort.abort();
						resolve(result);
					} else if (open === 0) {
						resolve({ kind: "unavailable" });
					}
				});
			}
			return promise;
		},
	};
}
