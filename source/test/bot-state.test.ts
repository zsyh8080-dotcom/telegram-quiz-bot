import assert from "node:assert/strict";
import test from "node:test";
import {
  addWrongQuestions,
  loadWrongQuestions,
  recordPollAnswer,
  rememberPoll,
  resetBotStateForTest,
} from "../lib/bot-state.ts";
import type { QuizQuestion } from "../lib/quiz.ts";

const question: QuizQuestion = {
  number: "1",
  text: "کدام گزینه درست است؟",
  options: ["اول", "دوم", "سوم", "چهارم"],
  correct_index: 2,
  answer_evidence: "EXPLICIT_ANSWER: option 3; پاسخ کارشناس: گزینه ۳",
  explanation: "گزینه سوم طبق متن درست است.",
};

test("stores each incorrectly answered poll once in the mistake bank", async () => {
  resetBotStateForTest();
  await rememberPoll("poll-wrong", 10, question);
  const first = await recordPollAnswer("poll-wrong", 10, [0]);
  const duplicate = await recordPollAnswer("poll-wrong", 10, [1]);
  assert.deepEqual(first, { added: true, count: 1 });
  assert.deepEqual(duplicate, { added: false, count: 1 });
  assert.equal((await loadWrongQuestions(10)).length, 1);
});

test("does not add correct or retracted votes to the mistake bank", async () => {
  resetBotStateForTest();
  await rememberPoll("poll-correct", 11, question);
  assert.deepEqual(await recordPollAnswer("poll-correct", 11, [2]), {
    added: false,
    count: 0,
  });
  assert.deepEqual(await recordPollAnswer("poll-correct", 11, []), {
    added: false,
    count: 0,
  });
});

test("keeps dated mistake history and can select only today's questions", async () => {
  resetBotStateForTest();
  const yesterday = Date.UTC(2026, 6, 22, 8);
  const today = Date.UTC(2026, 6, 23, 8);
  await addWrongQuestions(12, [question], yesterday);
  assert.equal((await loadWrongQuestions(12, today)).length, 0);
  await addWrongQuestions(
    12,
    [{ ...question, number: "2", text: "سؤال تازهٔ امروز؟" }],
    today,
  );
  assert.equal((await loadWrongQuestions(12)).length, 2);
  assert.equal((await loadWrongQuestions(12, today)).length, 1);
});
