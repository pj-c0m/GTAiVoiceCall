// Профили консультантов: один файл в profiles/ — один консультант.
// «Как говорит» → голосовой модели, «Как думает» + «Что знает» → бэкенду.
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const profilesDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "profiles");

// Голоса GPT-Live (openai.types.live.BuiltInVoice). Выбирается до старта сессии.
export const VOICES = new Set([
  "alloy", "ash", "ballad", "beacon", "bossa", "cedar", "cinder", "coral",
  "delta", "echo", "gleam", "marin", "meridian", "quartz", "ripple", "sage",
  "shimmer", "stone", "tempo", "verse", "vesper", "willow",
]);

export function parseProfile(id, text) {
  const split = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (!split) throw new Error(`${id}: нет шапки между --- ... ---`);

  const meta = {};
  for (const line of split[1].split("\n")) {
    const at = line.indexOf(":");
    if (at > 0) meta[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }

  const sections = {};
  let current = null, buffer = [];
  for (const line of split[2].split("\n")) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      if (current) sections[current] = buffer.join("\n").trim();
      current = heading[1].toLowerCase();
      buffer = [];
    } else buffer.push(line);
  }
  if (current) sections[current] = buffer.join("\n").trim();

  const profile = {
    id,
    label: meta.label || id,
    description: meta.description ?? "",
    name: meta.name ?? "",
    voice: VOICES.has(meta.voice) ? meta.voice : "alloy",
    search: (meta.search ?? "on").toLowerCase() !== "off",
    phone: (meta.phone ?? "").toLowerCase() === "yes",   // профиль для исходящих звонков
    speech: sections["как говорит"],
    mind: sections["как думает"],
    knows: sections["что знает"] ?? "",
  };
  if (!profile.speech) throw new Error(`${id}: нет раздела «## Как говорит»`);
  if (!profile.mind) throw new Error(`${id}: нет раздела «## Как думает»`);
  return profile;
}

// Читается на каждый запрос: правки профилей видны без перезапуска.
export async function loadProfiles() {
  const files = (await readdir(profilesDir)).filter((f) => f.endsWith(".md")).sort();
  const profiles = new Map();
  for (const file of files) {
    const id = basename(file, ".md");
    try {
      profiles.set(id, parseProfile(id, await readFile(resolve(profilesDir, file), "utf8")));
    } catch (error) {
      console.error("Профиль пропущен —", error.message);
    }
  }
  if (!profiles.size) throw new Error("в profiles/ нет ни одного рабочего профиля");
  return profiles;
}

// Профиль по умолчанию для режима «свой промпт»: оператор пишет роль сам, файлы — в базу знаний.
const DEFAULT_SPEECH = `Ты — голосовой ассистент. Говоришь по-русски, живой разговорной речью, короткими
репликами — одна-две фразы. Перебили — замолкаешь и слушаешь. Факты, цифры и условия берёшь у бэкенда,
пока он отвечает — не молчишь. Ничего не выдумываешь.`;
const DEFAULT_MIND = `Ты — бэкенд голосового ассистента. Возвращаешь одну-две короткие фразы для произнесения
вслух, без списков и markdown, числа словами. Отвечаешь только из базы знаний ниже (это файлы и заметки,
которые приложил оператор). Нет в базе — так и скажи: «этого у меня нет, уточню». Ничего не выдумывай.`;

export function defaultProfile() {
  return { id: "custom", label: "Свой промпт", description: "Роль и инструкции задаёт оператор", name: "",
           voice: "alloy", search: false, phone: false, speech: DEFAULT_SPEECH, mind: DEFAULT_MIND, knows: "" };
}

const PHONE_NOTE = `Ты говоришь по телефону. Человек не видит экрана, связь бывает с помехами:
реплики короче, чем в чате, после вопроса — жди ответа. Если тишина дольше пяти секунд —
переспроси «Вы меня слышите?». Если попала не туда — извинись и попрощайся.`;

// Конфигурация Live-сессии, общая для браузера (WebRTC) и телефона (WebSocket, A-law).
// instructions — промпт оператора (заменяет «Как говорит» профиля); files — [{name, text}] в базу знаний.
export function sessionFor(profile, { voice, context = "", backendModel, phone = false, name = "",
                                      instructions = "", files = [] } = {}) {
  const extra = context.trim()
    ? `\n\n# Добавлено оператором перед разговором\n\n${context.trim().slice(0, 6000)}`
    : "";
  const attached = files.filter((f) => f && typeof f.text === "string" && f.text.trim())
    .map((f) => `## Файл: ${String(f.name ?? "без имени").slice(0, 120)}\n\n${f.text.trim()}`)
    .join("\n\n").slice(0, 120_000);
  const knows = [profile.knows, attached].filter(Boolean).join("\n\n") || "(база знаний пуста)";
  const speech = instructions.trim() ? instructions.trim().slice(0, 40_000) : profile.speech;
  const client = name.trim()
    ? `Ты звонишь клиенту по имени ${name.trim().slice(0, 60)}. Обращайся к нему по имени и на «вы».\n\n`
    : "";
  return {
    model: "gpt-live-1",
    instructions: phone ? `${client}${PHONE_NOTE}\n\n${speech}` : speech,
    audio: {
      ...(phone ? { format: { type: "audio/pcma", rate: 8000 } } : {}),
      output: { voice: VOICES.has(voice) ? voice : profile.voice },
    },
    delegation: {
      type: "responses",
      responses: {
        model: backendModel,
        instructions: `${profile.mind}\n\n# База знаний\n\n${knows}${extra}`,
        ...(profile.search ? { tools: [{ type: "web_search" }], tool_choice: "auto" } : {}),
      },
    },
  };
}

// Новый операторский поток дополняет сценарий; legacy prompt API сохраняет замену речи.
export function jobSessionFor(profile,input,{backendModel}={}) {
  const assignment=[input.topic&&`Тема разговора: ${input.topic}`,input.goal&&`Цель разговора: ${input.goal}`,input.context].filter(Boolean).join('\n\n');
  const session=sessionFor(profile,{...input,instructions:'',context:assignment,backendModel,phone:true,name:input.name});
  if(assignment)session.instructions+=`\n\n# Задание оператора\n${assignment}`;
  if(input.instructions?.trim())session.instructions+=`\n\n# Дополнительные инструкции оператора\n${input.instructions.trim()}`;
  return session;
}
