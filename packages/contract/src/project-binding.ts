import { z } from "zod";

export const PROJECT_BINDING_DIR = ".coagents";
export const PROJECT_BINDING_FILE = "project.json";

// Contents of .coagents/project.json in a working directory. Never holds credentials.
export const ProjectBinding = z
  .object({
    server: z.url({ protocol: /^https?$/ }),
    project_id: z.string().min(1).max(64),
  })
  .strict();
export type ProjectBinding = z.infer<typeof ProjectBinding>;
