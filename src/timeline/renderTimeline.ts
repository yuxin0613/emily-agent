import type { Timeline } from "../types.ts";

export function renderTimeline(timeline: Timeline): string {
  const lines = [];
  if (timeline.run) {
    lines.push(`${time(timeline.run.startedAt)} run ${timeline.run.status}: ${timeline.run.userInput}`);
  }

  for (const event of timeline.events) {
    const task = timeline.tasks.find((item) => item.id === event.taskId);
    const label = task ? `${task.role}:${task.title}` : "runtime";
    lines.push(`${time(event.createdAt)} ${event.type} ${label}`);
  }

  return lines.join("\n");
}

function time(value: string): string {
  return new Date(value).toISOString().slice(11, 19);
}
