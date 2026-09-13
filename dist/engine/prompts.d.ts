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
export declare function buildActionMessages(instruction: string, observation: Observation, history?: string[]): Message[];
export declare function buildAssertMessages(question: string, observation: Observation): Message[];
