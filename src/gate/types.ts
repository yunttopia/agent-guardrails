// Tool and risk types shared by the gate and the queue.
export type Risk = "none" | "irreversible" | "outbound" | "money_out";

export interface ToolCall { id: string; name: string; args: unknown }
export interface ToolSpec {
  name: string;
  effect: "read" | "local_write" | "external_irreversible" | "external_reversible";
  risk: Risk;
  network: boolean;
}
export interface ToolOutcome {
  content: string;
  status: "ok" | "error" | "blocked" | "unknown";
  http_status?: number | null;
}
export type TaskOrigin =
  | { kind: "user_message"; user_message_id: string }
  | { kind: "standing_order"; order_id: string; scope_sha256: string }
  | { kind: "background" };
/** Delegation stage: 1 = a human approves every outbound action; higher stages allow standing rules. */
export interface DelegationSettings { stage: 1 | 2 | 3 | 4; amount_cap_on: boolean; amount_cap: { currency: "KRW" | "USD"; minor: number } | null }
