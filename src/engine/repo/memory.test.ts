import { InMemoryRepository } from "./memory";
import { repositoryContract } from "./contract";

repositoryContract("in-memory", async () => new InMemoryRepository());
