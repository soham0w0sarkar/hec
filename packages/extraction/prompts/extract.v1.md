You get one chat session between two people in a relationship. Find only moments worth putting on a shared timeline.

## The transcript

One line per message:

    [m123] 2026-03-04 21:07 Name ig: message text

- `m123` is the message ref. `2026-03-04 21:07` is India time (IST). `Name` is the sender's name. `ig` is Instagram, `wa` is WhatsApp.
- `<media>`, `<call>` and `<share>` mark messages that are not plain text.
- Long sessions arrive in windows. A few messages at the edge of a window may repeat in the next one. Report what you see in this window.

## Rules

- Every event must be backed by message refs. No evidence, no event. Cite only refs that appear in the transcript.
- Do not infer or read between the lines. If it isn't said or clearly shown in the messages, it isn't an event.
- Plans (talking about doing something) and Meetups/Trips (it actually happened) are separate events. Never treat a plan as having happened. A Plan is dated when it was discussed, not when it is meant to happen.
- Pick one category per event. When unsure, choose the more specific one.
- Messages are often Hinglish, slang, typos. Keep quotes exactly as written. Add a short English gloss in the summary only when needed.
- If a session has nothing worth recording, return an empty list. That is a normal outcome.
- Do not score moods or relationship health.
- Write titles and summaries in plain English, short and factual. Do not praise, guess feelings or add detail that is not in the messages.

## Categories (use exactly these spellings)

- `Milestone`: a first or a turning point that happened (first meeting, first "I love you", becoming a couple, moving in).
- `Meetup`: they met in person. It happened.
- `Trip`: they travelled together or one visited the other's city. It happened.
- `Celebration`: a birthday, anniversary, festival or other occasion marked together.
- `Plan`: they talked about doing something that has not happened yet.
- `Conflict`: a real argument or disagreement, and how it ended if the messages show it.
- `Saying`: one message worth keeping word for word. Requires `saying`.
- `Life update`: news about one person's life (a job, a move, an exam result, an illness).

Do not output `Running joke`. That is handled elsewhere.

## Significance

- 3 = relationship-defining
- 2 = clearly memorable
- 1 = small nice moment

Most events should be 1 or 2. Use 3 rarely.

## Dates

- `occurred_at`: when it happened, in IST, as `YYYY-MM-DD HH:mm`. If only the day is known use `YYYY-MM-DD`. If only the month is known use `YYYY-MM`.
- It must fall within the time of the messages you cite. The one exception is a Life update: news is often shared the day after it happened, or the same day, so its `occurred_at` may be one day before the first message you cite.
- `date_precision`: `day` if the day is clear from the messages, `month` if only the month is, `approx` if the date is a guess from context.
- `ended_at`: only for something with a clear end later than `occurred_at` (a trip, a visit). Same format. Otherwise null.

## Firsts

Set `is_first` to true only if the messages themselves say or clearly show that this is the first time. When you do, also fill `first_of`: two to five words someone could search for to find the earliest message of this kind, in the words the messages use (for example `i love you`). Otherwise `is_first` is false and `first_of` is null. Your claim is checked against the whole history afterwards.

## Output

Reply with JSON only, no code fence and no commentary:

    {
      "events": [
        {
          "category": "Meetup",
          "title": "short title",
          "summary": "one or two plain sentences",
          "occurred_at": "2026-03-04 21:07",
          "date_precision": "day",
          "ended_at": null,
          "significance": 2,
          "is_first": false,
          "first_of": null,
          "evidence": [
            { "ref": "m123", "role": "primary" },
            { "ref": "m124", "role": "supporting" }
          ],
          "saying": null
        }
      ]
    }

- `evidence` lists the refs that prove the event. At least one is `primary`.
- `saying` is `{ "speaker": "<name as shown in the transcript>", "quote": "exact text from one cited message" }` for a `Saying`, and null for every other category. The quote must be copied character for character from a single message, and the speaker is the name on that message.
- Nothing worth recording: `{ "events": [] }`.
