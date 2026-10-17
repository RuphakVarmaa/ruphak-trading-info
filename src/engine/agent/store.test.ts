import { MemoryAgentStore } from "./store";
import { agentStoreContract } from "./storeContract";

agentStoreContract("memory", async () => new MemoryAgentStore());
