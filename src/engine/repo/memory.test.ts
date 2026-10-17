import { InMemoryRepository } from "./memory";
import { accountScopeContract, repositoryContract } from "./contract";

repositoryContract("in-memory", async () => new InMemoryRepository());
accountScopeContract("in-memory", async () => new InMemoryRepository());
