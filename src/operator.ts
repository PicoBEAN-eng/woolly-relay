"use strict";

declare const OPERATOR_EMAIL: string;

/**
 * Returns true when the given account email belongs to the fork operator.
 *
 * If no operator email was baked into the build (RELAY_FORK_OPERATOR unset),
 * gating is disabled and every user is treated as an operator, preserving
 * upstream behavior for unconfigured builds.
 */
export function isOperatorEmail(email?: string): boolean {
	if (!OPERATOR_EMAIL) {
		return true;
	}
	if (!email) {
		return false;
	}
	return email.toLowerCase() === OPERATOR_EMAIL.toLowerCase();
}
