import { prisma } from "@/lib/db";
import { inngest } from "./client";
import { Sandbox } from "@e2b/code-interpreter";
import { MessageRole, MessageType } from "@/generated/prisma/enums";

import { createAgent, createNetwork, createState, createTool, gemini } from "@inngest/agent-kit"
import { FRAGMENT_TITLE_PROMPT, PROMPT, RESPONSE_PROMPT } from "@/lib/prompt";
import z from "zod"
import { agentOutputText, connectSandbox, lastAssistantTextMessageContent } from "./utils";

// Your prebuilt E2B template (the one that worked for you)
const SANDBOX_TEMPLATE = "ubpyxhq6jmetdwc05m3c";

// Free-tier limits from AI Studio: Flash Lite = 15 RPM / 500 RPD
// (Gemini 3.6 Flash was only 5 RPM / 20 RPD).
// Confirm the exact model IDs in AI Studio and edit if they differ.
const PRIMARY_MODEL = "gemini-3.1-flash-lite";
const FALLBACK_MODEL = "gemini-3.5-flash-lite";

const makeModel = (name: string) =>
  gemini({ model: name, apiKey: process.env.GEMINI_API_KEY! });

export interface CodeAgentState {
  sandboxId: string;
  summary: string;
  files: Record<string, string>;
}


export const processTask = inngest.createFunction(
  { id: "process-task", triggers: { event: "app/task.created" } },
  async ({ event, step }) => {
    const result = await step.run("handle-task", async () => {
      return { processed: true, id: event.data.id };
    });

    await step.sleep("pause", "1s");

    return { message: `Task ${event.data.id} complete`, result };
  }
);

export const codeAgentFunction = inngest.createFunction(
  { id: "code-agent", triggers: { event: "code-agent/run" }, retries: 5 },
  async ({ event, step }) => {
    const sandboxId = await step.run("get-sandbox-id", async () => {
      const sandbox = await Sandbox.create(SANDBOX_TEMPLATE);

      return sandbox.sandboxId;
    })

    const previousMessages = await step.run("get-previous-messages", async () => {
      const messages = await prisma.message.findMany({
        where: {
          projectId: event.data.projectId
        },
        orderBy: {
          createdAt: "asc"
        }
      });

      return messages.map((message) => ({
        type: "text" as const,
        role:
          message.role === MessageRole.ASSISTANT
            ? ("assistant" as const)
            : ("user" as const),
        content: message.content,
      }))
    });

    const state = createState<CodeAgentState>(
      { sandboxId, summary: "", files: {} },
      { messages: previousMessages }
    );

    // Builds the code agent for a given model (so we can swap to the fallback)
    const buildCodeAgent = (modelName: string) => createAgent({
      name: "code-agent",
      description: "An expert coding agent",
      system: PROMPT,
      model: makeModel(modelName),
      tools: [
        // 1. Terminal
        createTool({
          name: "terminal",
          description: "Use the terminal to run commands",
          parameters: z.object({
            command: z.string(),
          }),
          handler: async ({ command }, { step }) => {
            return await step?.run("terminal", async () => {
              const buffers = { stdout: "", stderr: "" };

              try {
                const sandbox = await Sandbox.connect(sandboxId);

                const result = await sandbox.commands.run(command, {
                  onStdout: (data) => {
                    buffers.stdout += data;
                  },

                  onStderr: (data) => {
                    buffers.stderr += data;
                  },
                });

                return result.stdout;
              } catch (error) {
                console.log(
                  `Command failed: ${error} \n stdout: ${buffers.stdout}\n stderr: ${buffers.stderr}`
                );

                return `Command failed: ${error} \n stdout: ${buffers.stdout}\n stderr: ${buffers.stderr}`;
              }
            });
          },
        }),

        // 2. createOrUpdateFiles
        createTool({
          name: "createOrUpdateFiles",
          description: "Create or update files in the sandbox",
          parameters: z.object({
            files: z.array(
              z.object({
                path: z.string(),
                content: z.string(),
              })
            ),
          }),

          handler: async ({ files }, { step, network }) => {
            const newFiles = await step?.run(
              "createOrUpdateFiles",
              async () => {
                try {
                  const updatedFiles = { ...(network?.state?.data.files || {}) };

                  const sandbox = await Sandbox.connect(sandboxId);

                  for (const file of files) {
                    await sandbox.files.write(file.path, file.content);
                    updatedFiles[file.path] = file.content;
                  }

                  return updatedFiles;
                } catch (error) {
                  return "Error: " + error;
                }
              }
            );

            if (newFiles && typeof newFiles === "object" && network) {
              network.state.data.files = newFiles;
            }
          },
        }),

        // 3. readFiles
        createTool({
          name: "readFiles",
          description: "Read files in the sandbox",

          parameters: z.object({
            files: z.array(z.string()),
          }),
          handler: async ({ files }, { step }) => {
            return await step?.run("readFiles", async () => {
              try {
                const sandbox = await Sandbox.connect(sandboxId);

                const contents: { path: string; content: string }[] = [];

                for (const file of files) {
                  const content = await sandbox.files.read(file);
                  contents.push({ path: file, content });
                }
                return JSON.stringify(contents);
              } catch (error) {
                return "Error: " + error;
              }
            });
          },
        }),
      ],

      lifecycle: {
        onResponse: async ({ result, network }) => {
          // short log (the full result dumps the whole system prompt every time)
          console.log(`[${modelName}] response, stop_reason:`, result.output?.[0]?.stop_reason);

          const lastAssistantMessageText =
            lastAssistantTextMessageContent(result);

          if (lastAssistantMessageText && network) {
            if (lastAssistantMessageText.includes("<task_summary>")) {
              network.state.data.summary = lastAssistantMessageText;
            }
          }

          return result;
        },
      },
    });

    // Runs the whole agent network with one model
    const runWithModel = async (modelName: string) => {
      const codeAgent = buildCodeAgent(modelName);

      const network = createNetwork({
        name: "code-agent-network",
        agents: [codeAgent],
        maxIter: 15,
        router: async ({ network }) => {
          const summary = network.state.data.summary;

          if (summary) {
            return;
          }

          return codeAgent;
        }
      });

      return network.run(event.data.value, { state });
    };

    // Try the primary model first, then the fallback if it fails (e.g. 503)
    let result: Awaited<ReturnType<typeof runWithModel>>;

    try {
      result = await runWithModel(PRIMARY_MODEL);
    } catch (primaryError) {
      console.error(`${PRIMARY_MODEL} failed, trying ${FALLBACK_MODEL}:`, primaryError);

      result = await runWithModel(FALLBACK_MODEL);
    }

    const { summary, files } = result.state.data;

    // Title + response agents: try primary, then fallback, never crash the run
    const runTextAgent = async (
      name: string,
      system: string,
      input: string,
      defaultText: string
    ): Promise<string> => {
      for (const modelName of [PRIMARY_MODEL, FALLBACK_MODEL]) {
        try {
          const agent = createAgent({ name, system, model: makeModel(modelName) });
          const { output } = await agent.run(input, { step });

          return agentOutputText(output, defaultText);
        } catch (error) {
          console.error(`${name} failed on ${modelName}:`, error);
        }
      }

      return defaultText;
    };

    const fragmentTitle = summary
      ? await runTextAgent("fragment-title-generator", FRAGMENT_TITLE_PROMPT, summary, "Untitled")
      : "Untitled";

    const responseText = summary
      ? await runTextAgent("response-generator", RESPONSE_PROMPT, summary, "Here you go")
      : "Here you go";

    console.log(Object.keys(files || {}));

    const isError =
      !summary ||
      Object.keys(files || {}).length === 0;


    const sandboxUrl = await step.run("get-sandbox-url", async () => {
      const sandbox = await connectSandbox(sandboxId);
      return `http://${sandbox.getHost(3000)}`
    });

    await step.run("save-result", async () => {
      if (isError) {
        return prisma.message.create({
          data: {
            projectId: event.data.projectId,
            content: "Something went wrong. Please try again",
            role: MessageRole.ASSISTANT,
            type: MessageType.ERROR,
          },


        })
      };

      return prisma.message.create({
        data: {
          projectId: event.data.projectId,
          content: responseText,
          role: MessageRole.ASSISTANT,
          type: MessageType.RESULT,
          fragments: {
            create: {
              sandboxUrl,
              title: fragmentTitle,
              files
            }
          }
        }
      })
    });

    return {
      url: sandboxUrl, title: fragmentTitle, files, summary
    }
  }

)