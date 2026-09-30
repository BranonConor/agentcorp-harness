const greetings = [
  "What are we working on next?",
  "How can I help?",
  "Whatdya need, boss?",
  "Got a task in mind?",
  "Ready when you are.",
  "What would you like to explore?",
  "Where should we begin?",
  "Need a second pair of eyes?",
  "What can I look into?",
  "What's first on the list?",
  "Want to build something?",
  "How can I pitch in?",
  "What should we tackle?",
  "Any ideas you'd like to try?",
  "What can I help untangle?",
  "What's on your mind?",
] as const;

export function greetingForPersona(persona: number): string {
  return greetings[persona % greetings.length];
}
