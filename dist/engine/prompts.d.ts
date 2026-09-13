import { Observation } from '../driver/browser.js';
import { JsonSchema, Message } from '../vision/openrouter.js';
import { ActionPayload } from '../cache/fingerprint.js';
export interface ProposedAction extends ActionPayload {
    reasoning: string;
}
export interface AssertionResult {
    verdict: 'pass' | 'fail';
    reasoning: string;
}
export declare const actionSchema: JsonSchema;
export declare const assertionSchema: JsonSchema;
/** One executed record step as it appears in the next prompt's transcript. */
export interface PriorAction {
    action: ActionPayload;
    /** Resolved element label (a11y snippet) when the action hit a node. */
    label?: string;
}
/** Compact one-line rendering of an executed action for the record transcript. */
export declare function describeAction(action: ActionPayload, label?: string): string;
export declare function buildActionMessages(instruction: string, observation: Observation, priorActions?: PriorAction[]): Message[];
export declare function buildAssertMessages(question: string, observation: Observation): Message[];
