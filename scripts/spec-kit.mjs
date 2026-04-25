#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const GATE_ORDER = ["plan", "review", "execute", "qa", "acceptance"];
const GATE_LABELS = {
  acceptance: "Acceptance",
  execute: "Execute",
  plan: "Plan",
  qa: "QA",
  review: "Review",
};
const GATE_PLAYBOOK = {
  acceptance: [
    "确认所有 gate 均已通过，并记录最终验收结论。",
    "把 phase 状态切换为 closed，准备进入下一 phase。",
  ],
  execute: [
    "实现当前 phase 的代码改动，不允许绕过 Review 直接推进。",
    "记录变更范围、风险和回滚点。",
  ],
  plan: [
    "补全 phase 目标、非目标、交付物、退出标准。",
    "确认本 phase 对应 SOP 的硬规则，不允许含糊描述。",
  ],
  qa: [
    "运行真实或模拟 QA，用结果而不是推测判断通过与否。",
    "至少覆盖：核心主路径、失败路径、恢复路径。",
  ],
  review: [
    "评审 plan，检查范围漂移、隐含假设和缺失状态。",
    "输出结论后才能进入 Execute。",
  ],
};

const cwd = process.cwd();
const registryPath = path.join(cwd, "spec-kit", "phases.json");
const templatePath = path.join(cwd, "spec-kit", "templates", "phase-spec.template.md");

function parseArgs(argv) {
  const parsed = { _: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      parsed._.push(token);
      continue;
    }

    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      parsed[key] = "true";
      continue;
    }

    parsed[key] = value;
    index += 1;
  }

  return parsed;
}

function assertGateName(gateName) {
  if (!GATE_ORDER.includes(gateName)) {
    throw new Error(`Unknown gate: ${gateName}. Expected one of ${GATE_ORDER.join(", ")}.`);
  }
}

function nowIso() {
  return new Date().toISOString();
}

function toSlug(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function loadRegistry() {
  const raw = await readFile(registryPath, "utf-8");
  return JSON.parse(raw);
}

async function saveRegistry(registry) {
  await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf-8");
}

function findPhase(registry, id) {
  const phase = registry.phases.find((item) => item.id === id);
  if (!phase) {
    throw new Error(`Phase not found: ${id}`);
  }

  return phase;
}

function formatGateState(phase, gateName) {
  return phase.gates[gateName] ? "done" : "todo";
}

function nextGate(phase) {
  return GATE_ORDER.find((gateName) => phase.gates[gateName] !== true) || null;
}

function ensureGateSequence(phase, targetGate) {
  const targetIndex = GATE_ORDER.indexOf(targetGate);
  for (let index = 0; index < targetIndex; index += 1) {
    const gateName = GATE_ORDER[index];
    if (phase.gates[gateName] !== true) {
      throw new Error(
        `Cannot complete ${targetGate} before ${gateName}. Phase ${phase.id} must pass gates in order.`,
      );
    }
  }
}

async function appendEvidence(phase, gateName, evidence) {
  if (!evidence) {
    return;
  }

  const absoluteSpecPath = path.join(cwd, phase.specPath);
  const stamp = nowIso();
  const snippet = `\n- ${stamp} [${gateName}] ${evidence}`;
  await writeFile(absoluteSpecPath, `${await readFile(absoluteSpecPath, "utf-8")}${snippet}`, "utf-8");
}

async function createPhaseFromTemplate(registry, args) {
  const id = args.id;
  const title = args.title;
  if (!id || !title) {
    throw new Error("create command requires --id and --title.");
  }

  if (registry.phases.some((phase) => phase.id === id)) {
    throw new Error(`Phase ${id} already exists.`);
  }

  const phaseSlug = toSlug(`${id}-${title}`);
  const relativeSpecPath = path.join("spec-kit", "phases", `${phaseSlug}.md`);
  const absoluteSpecPath = path.join(cwd, relativeSpecPath);

  await mkdir(path.dirname(absoluteSpecPath), { recursive: true });
  const template = await readFile(templatePath, "utf-8");
  const output = template
    .replaceAll("{{PHASE_ID}}", id)
    .replaceAll("{{PHASE_TITLE}}", title)
    .replaceAll("{{DATE}}", nowIso().slice(0, 10));
  await writeFile(absoluteSpecPath, output, "utf-8");

  registry.phases.push({
    gates: {
      acceptance: false,
      execute: false,
      plan: false,
      qa: false,
      review: false,
    },
    id,
    specPath: relativeSpecPath,
    status: "in_progress",
    title,
    updatedAt: nowIso(),
  });
  registry.activePhase = id;
  await saveRegistry(registry);

  process.stdout.write(`Created phase ${id}: ${title}\nSpec: ${relativeSpecPath}\n`);
}

function printStatus(registry) {
  process.stdout.write(`Active phase: ${registry.activePhase}\n\n`);
  process.stdout.write("ID  | Status       | Plan | Review | Execute | QA   | Acceptance | Title\n");
  process.stdout.write("----|--------------|------|--------|---------|------|------------|------\n");

  for (const phase of registry.phases) {
    const line = [
      phase.id.padEnd(3),
      String(phase.status).padEnd(12),
      formatGateState(phase, "plan").padEnd(4),
      formatGateState(phase, "review").padEnd(6),
      formatGateState(phase, "execute").padEnd(7),
      formatGateState(phase, "qa").padEnd(4),
      formatGateState(phase, "acceptance").padEnd(10),
      phase.title,
    ].join(" | ");
    process.stdout.write(`${line}\n`);
  }
}

function printAutoplanGuidance(phase) {
  const gateName = nextGate(phase);

  if (!gateName) {
    process.stdout.write(
      `Phase ${phase.id} already completed all gates. Run: node scripts/spec-kit.mjs close --id ${phase.id}\n`,
    );
    return;
  }

  process.stdout.write(`Phase ${phase.id} next gate: ${GATE_LABELS[gateName]} (${gateName})\n`);
  process.stdout.write("Required actions:\n");
  for (const item of GATE_PLAYBOOK[gateName]) {
    process.stdout.write(`- ${item}\n`);
  }
  process.stdout.write(
    `\nWhen done, run:\nnode scripts/spec-kit.mjs gate --id ${phase.id} --name ${gateName} --evidence "<proof>"\n`,
  );
}

async function completeGate(registry, args) {
  const id = args.id || registry.activePhase;
  const gateName = args.name;
  const evidence = args.evidence;
  if (!gateName) {
    throw new Error("gate command requires --name.");
  }
  assertGateName(gateName);

  const phase = findPhase(registry, id);
  ensureGateSequence(phase, gateName);
  phase.gates[gateName] = true;
  phase.updatedAt = nowIso();
  if (phase.status === "pending") {
    phase.status = "in_progress";
  }

  if (GATE_ORDER.every((item) => phase.gates[item] === true)) {
    phase.status = "ready_to_close";
  }

  await appendEvidence(phase, gateName, evidence);
  await saveRegistry(registry);
  process.stdout.write(`Marked gate ${gateName} as done for phase ${phase.id}.\n`);
}

async function closePhase(registry, args) {
  const id = args.id || registry.activePhase;
  const phase = findPhase(registry, id);

  const incomplete = GATE_ORDER.filter((gateName) => !phase.gates[gateName]);
  if (incomplete.length > 0) {
    throw new Error(`Cannot close phase ${phase.id}. Incomplete gates: ${incomplete.join(", ")}`);
  }

  phase.status = "closed";
  phase.updatedAt = nowIso();

  const currentIndex = registry.phases.findIndex((item) => item.id === phase.id);
  if (currentIndex >= 0 && currentIndex + 1 < registry.phases.length) {
    registry.activePhase = registry.phases[currentIndex + 1].id;
  }

  await saveRegistry(registry);
  process.stdout.write(`Phase ${phase.id} closed.\n`);
}

async function setActivePhase(registry, args) {
  if (!args.id) {
    throw new Error("active command requires --id.");
  }

  findPhase(registry, args.id);
  registry.activePhase = args.id;
  await saveRegistry(registry);
  process.stdout.write(`Active phase switched to ${args.id}.\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || "status";
  const registry = await loadRegistry();

  switch (command) {
    case "status":
      printStatus(registry);
      break;
    case "autoplan": {
      const id = args.id || registry.activePhase;
      const phase = findPhase(registry, id);
      printAutoplanGuidance(phase);
      break;
    }
    case "gate":
      await completeGate(registry, args);
      break;
    case "close":
      await closePhase(registry, args);
      break;
    case "active":
      await setActivePhase(registry, args);
      break;
    case "create":
      await createPhaseFromTemplate(registry, args);
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

main().catch((error) => {
  process.stderr.write(`spec-kit error: ${error.message}\n`);
  process.exitCode = 1;
});
