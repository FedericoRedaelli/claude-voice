#!/usr/bin/env node
// MCP stdio server exposing a single tool, `talk_to_user`. Claude calls it at a stopping
// point with its final message (+ optional offered options); the tool runs a voice (or
// text) session and returns the user's decision as JSON for Claude to act on.
//
// NOTE: stdout/stdin are the MCP JSON-RPC transport. All diagnostics go to stderr; the
// interactive text fallback talks to /dev/tty (see text.mjs).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { abortActiveSessions, runSession } from "./session.mjs";

// Safety net: a stray audio-pipe error (e.g. sox EPIPE) must never crash the MCP server,
// or every subsequent talk_to_user call would hang ("MCP failed to connect"). Log, survive.
process.on("uncaughtException", (e) =>
  process.stderr.write(`[claude-voice] uncaught (ignored): ${e?.stack ?? e}\n`),
);
process.on("unhandledRejection", (e) =>
  process.stderr.write(`[claude-voice] unhandledRejection (ignored): ${e?.stack ?? e}\n`),
);

const server = new McpServer({ name: "claude-voice", version: "0.1.0" });

server.registerTool(
  "talk_to_user",
  {
    title: "Talk to the user (voice)",
    description:
      "Speak your final message aloud and get the user's spoken (or typed) reply. Call this " +
      "at every stopping point instead of just ending. Pass your final message and, if you " +
      "offered the user a set of options, pass them in `options`. Returns JSON: " +
      '{"kind":"choice","value":<one option>} | {"kind":"message","value":<free text>} | ' +
      '{"kind":"end"}. On "choice"/"message" act on it and continue; on "end" you may stop.',
    inputSchema: {
      message: z
        .string()
        .describe("Your final message to the user — what you did and/or what you're asking."),
      options: z
        .array(z.string())
        .optional()
        .describe("The distinct choices you offered the user, if any."),
      spoken: z
        .string()
        .optional()
        .describe(
          "The opening line, written by YOU, to be read aloud word for word — one or two " +
            "short sentences, under about 35 words: what happened, then the question with " +
            "the options named and numbered. No code, no paths, no file names, no lists. " +
            "Omit it and the voice agent will compose its own opening from `message`, which " +
            "is slower and vaguer.",
        ),
    },
  },
  // `extra.signal` aborts when Claude Code cancels the request — which is what pressing Esc
  // does. Without it the voice session kept running (and talking) after the user bailed out.
  async ({ message, options, spoken }, extra) => {
    let decision;
    try {
      decision = await runSession({
        message: message ?? "",
        options: options ?? [],
        spoken: spoken ?? "",
        signal: extra?.signal,
      });
    } catch (err) {
      process.stderr.write(`[claude-voice] session error: ${String(err?.message ?? err)}\n`);
      decision = { kind: "end" };
    }
    return { content: [{ type: "text", text: JSON.stringify(decision) }] };
  },
);

// Quitting Claude Code kills or detaches this process; make sure no `sox` keeps talking.
// stdin closing is the normal signal that the client is gone.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    abortActiveSessions(sig);
    setTimeout(() => process.exit(0), 200).unref?.();
  });
}
process.stdin.on("close", () => abortActiveSessions("stdin closed"));

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write("[claude-voice] MCP server ready (stdio)\n");
