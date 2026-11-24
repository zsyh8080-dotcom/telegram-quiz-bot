import assert from "node:assert/strict";
import test from "node:test";
import { extractExplicitQuizFromOcr } from "../lib/gemini.ts";
import {
  CHATGPT_QUIZ_COPY_PROMPT,
  evidenceIndex,
  normalizeText,
  parseChatGptQuizText,
  quizExplanation,
  userFacingEvidence,
  validateExtraction,
  validateQuestions,
} from "../lib/quiz.ts";

test("ChatGPT prompt accepts a user-selected count with challenging questions", () => {
  assert.match(CHATGPT_QUIZ_COPY_PROMPT, /تعداد دلخواه/);
  assert.doesNotMatch(CHATGPT_QUIZ_COPY_PROMPT, /تعداد سؤال:\s*دقیقاً 40/);
  assert.match(CHATGPT_QUIZ_COPY_PROMPT, /چالش‌برانگیز/);
  assert.match(CHATGPT_QUIZ_COPY_PROMPT, /فقط از متن منبع/);
  assert.match(CHATGPT_QUIZ_COPY_PROMPT, /از من PDF یا فایل نخواه/);
});

test("normalizes Persian and Arabic digits", () => {
  assert.equal(normalizeText("گزینه ۲ و ٣"), "گزینه 2 و 3");
});

test("parses the strict ChatGPT quiz JSON format without PDF evidence", () => {
  const questions = parseChatGptQuizText(`\`\`\`json
  {
    "title": "بانکداری",
    "questions": [{
      "number": "۱",
      "question": "وظیفه اصلی بانک مرکزی چیست؟",
      "options": ["تنظیم سیاست پولی", "ساخت مسکن", "صدور گذرنامه", "اداره شهرداری"],
      "answer": 1,
      "explanation": "بانک مرکزی سیاست پولی را تنظیم می‌کند."
    }]
  }
  \`\`\``);
  assert.equal(questions.length, 1);
  assert.equal(questions[0].correct_index, 0);
  assert.match(questions[0].answer_evidence, /^EXPLICIT_ANSWER: option 1/);
  assert.equal(questions[0].number, "1");
});

test("rejects malformed ChatGPT quiz items and accepts zero-based correct_index", () => {
  const questions = parseChatGptQuizText(
    JSON.stringify({
      questions: [
        {
          text: "نمونه سالم؟",
          options: ["یک", "دو"],
          correct_index: 1,
        },
        {
          text: "بدون جواب؟",
          options: ["یک", "دو"],
        },
      ],
    }),
  );
  assert.equal(questions.length, 1);
  assert.equal(questions[0].correct_index, 1);
});

test("understands numeric, Persian-letter, English, and ordinal answers", () => {
  assert.equal(evidenceIndex("پاسخ کارشناس ایران استخدام: گزینه ۲"), 1);
  assert.equal(evidenceIndex("پاسخ صحیح: ب"), 1);
  assert.equal(evidenceIndex("Correct answer: option C"), 2);
  assert.equal(evidenceIndex("گزینه چهارم صحیح است"), 3);
  assert.equal(evidenceIndex("EXPLICIT_ANSWER: option 3; کلید: ۳"), 2);
  assert.equal(evidenceIndex("پاسخ کلیدی: ج"), 2);
  assert.equal(evidenceIndex("کلید پاسخ: گزینه سوم"), 2);
  assert.equal(evidenceIndex("✅ گزینه ۴"), 3);
});

test("extracts Persian letter options on one or several lines with پاسخ کلیدی", () => {
  const questions = extractExplicitQuizFromOcr([
    [
      "۱ - کدام گزینه جزو وظایف نظام بانکی نیست؟",
      "الف) انتشار اسکناس",
      "ب) هدایت گردش پول",
      "ج) جلوگیری از رشد نقدینگی د) انجام عملیات اسناد بهادار",
      "پاسخ کلیدی: ج",
    ].join("\n"),
  ]);
  assert.equal(questions.length, 1);
  assert.deepEqual(questions[0].options, [
    "انتشار اسکناس",
    "هدایت گردش پول",
    "جلوگیری از رشد نقدینگی",
    "انجام عملیات اسناد بهادار",
  ]);
  assert.equal(questions[0].correct_index, 2);
});

test("accepts explicit consistent answers and strips option labels", () => {
  const questions = validateQuestions({
    questions: [
      {
        number: "۱",
        text: "کدام گزینه درست است؟",
        options: ["۱) اول", "۲) دوم", "۳) سوم", "۴) چهارم"],
        correct_index: 1,
        answer_evidence: "EXPLICIT_ANSWER: option 2; پاسخ کارشناس: گزینه ۲",
        explanation: "",
      },
    ],
  });
  assert.equal(questions.length, 1);
  assert.deepEqual(questions[0].options, ["اول", "دوم", "سوم", "چهارم"]);
  assert.equal(questions[0].correct_index, 1);
});

test("rejects guesses, missing evidence, and mismatched answer labels", () => {
  const questions = validateQuestions({
    questions: [
      {
        number: "1",
        text: "بدون مدرک؟",
        options: ["الف", "ب"],
        correct_index: 0,
        answer_evidence: "",
        explanation: "",
      },
      {
        number: "2",
        text: "ناسازگار؟",
        options: ["یک", "دو"],
        correct_index: 0,
        answer_evidence: "پاسخ: گزینه 2",
        explanation: "",
      },
    ],
  });
  assert.deepEqual(questions, []);
});

test("validates the document page count alongside questions", () => {
  const result = validateExtraction({ total_pages: 554, questions: [] });
  assert.equal(result.total_pages, 554);
  assert.deepEqual(result.questions, []);
  assert.equal(
    validateExtraction({ total_pages: 1001, questions: [] }).total_pages,
    null,
  );
});

test("renders a clean Telegram explanation without the internal evidence marker", () => {
  const question = {
    number: "1",
    text: "نمونه سؤال",
    options: ["یک", "دو", "سه", "چهار"],
    correct_index: 2,
    answer_evidence:
      "EXPLICIT_ANSWER: option 3; پاسخ کارشناس ایران استخدام: گزینه 3",
    explanation:
      "طبق تبصره ۲ ماده ۴ قانون، ساختار اجرایی شورا به تصویب هیئت وزیران خواهد رسید.",
  };
  assert.equal(
    userFacingEvidence(question.answer_evidence),
    "پاسخ کارشناس ایران استخدام: گزینه 3",
  );
  const explanation = quizExplanation(question, 90);
  assert.match(explanation, /^✅ پاسخ درست: گزینه 3/);
  assert.match(explanation, /💡 راهنما:/);
  assert.doesNotMatch(explanation, /EXPLICIT_ANSWER|منبع پاسخ/);
  assert.ok(explanation.length <= 90);
});
