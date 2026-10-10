import type { StarResult } from "./types";
import { countFillers, countWords } from "./policy";

const FILLERS = new Set(["um", "uh", "uhh", "umm", "erm", "like", "so", "well"]);
const CONJUNCTIONS = new Set(["and", "but", "or", "so", "because", "that", "the", "to", "a", "an", "of", "with", "is", "was", "it"]);

export function heuristicShouldEnd(transcript: string, silenceMs: number): boolean {
  if (countWords(transcript) < 5) return false;
  if (silenceMs < 1500) return false;
  const tokens = transcript.toLowerCase().split(/\s+/).filter(Boolean);
  const last = tokens[tokens.length - 1]?.replace(/[^a-z']/g, "");
  return !FILLERS.has(last) && !CONJUNCTIONS.has(last);
}

const CUES: Record<string, RegExp[]> = {
  situation: [/when i (was|worked|joined|led)/i, /at (my|the) (previous|last|old)/i, /last year/i, /a few (months|years) ago/i, /we had/i, /the (team|company|product) was/i],
  task: [/i was (responsible|tasked|asked)/i, /my (job|role|task|goal) was/i, /i needed to/i, /i had to/i],
  action: [/i (built|wrote|designed|implemented|fixed|debugged|investigated|migrated|rolled out|created)/i, /first .*(then|after)/i, /i decided/i, /step/i],
  result: [/\d+%/i, /reduced|increased|improved|cut|doubled|halved/i, /\b\d+(k|m|ms|s|%)\b/i, /as a result/i, /in the end/i, /we shipped/i],
};

export function heuristicStar(question: string, answer: string): StarResult {
  const cueScore = (regexes: RegExp[]): number => {
    const hits = regexes.filter((r) => r.test(answer)).length;
    if (hits >= 2) return 3;
    if (hits === 1) return 2;
    return answer.length > 200 ? 1 : 0;
  };

  const onTopic = /bug|project|feature|deadline|feedback|priorit|metric|launch|refactor/i.test(question);
  return {
    situation: { score: cueScore(CUES.situation), confidence: 0.3 },
    task: { score: cueScore(CUES.task), confidence: 0.3 },
    action: { score: cueScore(CUES.action), confidence: 0.3 },
    result: { score: cueScore(CUES.result), confidence: 0.3 },
    relevance: { score: onTopic ? (answer.length > 100 ? 2 : 1) : 0, confidence: 0.2 },
    ownsActions: { noul: /\bi\b/i.test(answer) ? 0.7 : 0.3 },
    answerType: {
      choice: /(i (was|had|built|fixed|led)|when i)/i.test(answer)
        ? "real_example"
        : /would|will|i'd/i.test(answer)
          ? "hypothetical"
          : "generic",
      confidence: 0.3,
    },
    raw: { heuristic: true, words: countWords(answer), fillers: countFillers(answer) },
  };
}
