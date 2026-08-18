// Pausing whatever else is playing, for the length of a call.
//
// THE LIMIT THAT SHAPES THIS FILE: the page cannot do it. A browser tab has no way to pause
// Spotify, or another tab, or anything outside itself — there is no such API on the desktop,
// and the Media Session API only describes our own playback to the OS. So this runs in Node,
// which means it acts on the machine where CLAUDE CODE runs.
//
// On a laptop where you run both, that is the right machine and this simply works. Over
// Remote-SSH it is the wrong one — it would pause the music on a server nobody is listening
// to — and the honest answer is to leave it off there, which is why it is opt-in rather than
// clever. WSL is the interesting middle: powershell.exe reaches the Windows host, which is
// exactly where the sound is, so it works.
//
// It is also strictly best-effort. Every failure is silent and the call continues: a voice
// loop that breaks because a media player was not where it was expected would be a much worse
// bug than music that keeps playing.

import { spawnSync } from "node:child_process";

const log = (m) => process.stderr.write(`[claude-voice] media: ${m}\n`);

// macOS. Two AppleScript-driven players, asked rather than commanded: pausing something that
// was not playing is what makes "resume" resume the wrong thing at the end of the call.
// Prints the name of each app it actually paused, one per line — that list IS the memory.
const MAC_PAUSE = `
set paused to {}
repeat with appName in {"Spotify", "Music"}
  try
    if application appName is running then
      using terms from application "Spotify"
        tell application appName
          if player state is playing then
            pause
            set end of paused to appName
          end if
        end tell
      end using terms from
    end if
  end try
end repeat
set AppleScript's text item delimiters to linefeed
return paused as text
`;

export function resolveMedia({ platform = process.platform, env = process.env, has = () => false } = {}) {
  if (env.VOICE_PAUSE_MEDIA !== "1") return null; // opt-in, always
  if (env.VOICE_PAUSE_CMD) return { kind: "custom", pauseCmd: env.VOICE_PAUSE_CMD, resumeCmd: env.VOICE_RESUME_CMD || "" };
  if (platform === "darwin") return { kind: "mac" };
  // WSL first: the sound is on the Windows side, and so is the player worth pausing.
  if ((env.WSL_DISTRO_NAME || env.WSL_INTEROP) && has("powershell.exe")) return { kind: "windows" };
  if (platform === "win32") return { kind: "windows" };
  if (has("playerctl")) return { kind: "playerctl" };
  return null;
}

// What the mac script paused, as a list. Empty output means nothing was playing — and then
// there is nothing to resume, which is the case that matters: an unconditional "play" at the
// end of every call would start music you had deliberately stopped.
export function pausedApps(stdout) {
  return String(stdout ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

const run = (cmd, args, run_ = spawnSync) =>
  run_(cmd, args, { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] });

// Where the pause should happen, given what is attached. The agent wins whenever there is
// one: it runs on the machine with the browser, which is the machine with the speakers, and
// that is the whole question. Local is the fallback for the ordinary case where Claude Code
// and the browser are the same computer.
export function pauseVia({ agents = 0, how = resolveMedia(), exec = run, media = () => {} } = {}) {
  if (agents > 0) {
    media("pause");
    return () => media("resume");
  }
  return pauseMedia({ how, exec });
}

// Pause, and return the resume function. Returning it — rather than storing state in the
// module — is what guarantees that a resume can only undo a pause that actually happened.
export function pauseMedia({ how = resolveMedia(), exec = run } = {}) {
  const nothing = () => {};
  if (!how) return nothing;

  try {
    if (how.kind === "mac") {
      const res = exec("osascript", ["-e", MAC_PAUSE]);
      const apps = pausedApps(res?.stdout);
      if (!apps.length) return nothing;
      log(`paused ${apps.join(", ")}`);
      return () => {
        for (const app of apps) {
          try {
            exec("osascript", ["-e", `tell application "${app}" to play`]);
          } catch {
            /* the player quit mid-call; nothing to put back */
          }
        }
      };
    }

    if (how.kind === "playerctl") {
      const status = exec("playerctl", ["status"]);
      if (!/playing/i.test(status?.stdout ?? "")) return nothing;
      exec("playerctl", ["pause"]);
      log("paused the MPRIS player");
      return () => {
        try {
          exec("playerctl", ["play"]);
        } catch {
          /* gone */
        }
      };
    }

    if (how.kind === "windows") {
      // The one platform with no way to ASK. The media key is a toggle, so this can only be
      // blind: if nothing was playing, the pause starts something and the resume stops it
      // again. Documented, opt-in, and the reason the other two branches query first.
      const key = "(Add-Type -MemberDefinition '[DllImport(\"user32.dll\")]public static extern void keybd_event(byte b,byte s,int f,int e);' -Name K -Namespace W -PassThru)::keybd_event(0xB3,0,0,0)";
      exec("powershell.exe", ["-NoProfile", "-Command", key]);
      log("sent the play/pause key to Windows");
      return () => {
        try {
          exec("powershell.exe", ["-NoProfile", "-Command", key]);
        } catch {
          /* ignore */
        }
      };
    }

    if (how.kind === "custom") {
      exec("sh", ["-c", how.pauseCmd]);
      log("ran VOICE_PAUSE_CMD");
      return () => {
        if (!how.resumeCmd) return;
        try {
          exec("sh", ["-c", how.resumeCmd]);
        } catch {
          /* ignore */
        }
      };
    }
  } catch (err) {
    log(`could not pause (${String(err?.message ?? err)}) — carrying on`);
  }
  return nothing;
}
