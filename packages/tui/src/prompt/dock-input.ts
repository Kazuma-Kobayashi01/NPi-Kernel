/**
 * Whether the prompt is docked to the bottom row from the first frame. Off by default for the
 * dependency-free composer; the application turns it on from `composer.dockInput`.
 */
let docked = false;

export function setComposerDockInput(enabled: boolean): void {
	docked = enabled;
}

export function isComposerDockInput(): boolean {
	return docked;
}
