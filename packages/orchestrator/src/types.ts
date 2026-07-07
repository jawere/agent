// @jawere/orchestrator — Types for multi-agent orchestration

export interface InstanceInfo {
  id: string;
  status: "running" | "stopped" | "error";
  sessionId?: string;
  sessionName?: string;
  model?: string;
  provider?: string;
  createdAt: string;
  lastActive: string;
  pid?: number;
  metadata?: Record<string, unknown>;
}

export interface OrchestratorConfig {
  instancesDir: string;
  rpcTimeout: number;
  maxInstances: number;
}

export interface RpcRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export interface RpcResponse {
  id: string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface OrchestratorSupervisor {
  createInstance(options?: { sessionId?: string; model?: string }): Promise<InstanceInfo>;
  listInstances(): Promise<InstanceInfo[]>;
  removeInstance(id: string): Promise<void>;
  getState(id: string): Promise<InstanceInfo | undefined>;
  prompt(id: string, message: string): Promise<{ messages: unknown[] }>;
  newSession(id: string): Promise<void>;
  switchSession(id: string, sessionId: string): Promise<void>;
  forkSession(id: string, sessionId: string): Promise<string>;
}
