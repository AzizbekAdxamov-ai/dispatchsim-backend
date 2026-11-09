// The server's own rate lines, in the broker's writing style. The numbers come
// from the decision (the quote text is passed in); only the wording varies, so
// one broker does not say the same sentence on every turn. Each list holds
// VARIANT_MIN..VARIANT_MAX wordings per style; pickVariant picks one by
// broker + conversation + turn, so a retry of the same turn says the same thing.
//
// Lines that carry other facts (agreement, email, MC, hold, cancel, paper) are
// not here: guards and tests depend on their exact words.
//
// counter / meet / walkCounter / confirmOffer / invalidFigure are used while the
// broker still has room, so none of them may claim a limit. maxFirst / maxAgain
// are used only when the offer has reached the ceiling.
export const VARIANT_MIN = 4
export const VARIANT_MAX = 6

export const LINE_VARIANTS = Object.freeze({
  // A new, higher offer that is not what was asked.
  counter: Object.freeze({
    casual: Object.freeze([
      (q) => `i can do ${q} rn. that work for u?`,
      (q) => `${q} is where i am rn, work for u?`,
      (q) => `i can get u to ${q}, that ok?`,
      (q) => `how's ${q} sound?`,
    ]),
    neutral: Object.freeze([
      (q) => `I can offer ${q}. Does that work for you?`,
      (q) => `I can move to ${q}. Does that work?`,
      (q) => `Where I can be is ${q}. How does that look?`,
      (q) => `I can do ${q} on this one. Will that work?`,
    ]),
    formal: Object.freeze([
      (q) => `I am able to offer ${q}. Would that be acceptable to you?`,
      (q) => `I can improve our offer to ${q}. Does that work for you?`,
      (q) => `Our offer is now ${q}. Would that work for you?`,
      (q) => `I can offer ${q} for this load. Is that acceptable?`,
    ]),
  }),
  // The counter equals what the carrier asked.
  meet: Object.freeze({
    casual: Object.freeze([
      (q) => `i can do ${q}. want me to book it?`,
      (q) => `ok ${q} i can do. should i book it?`,
      (q) => `i can meet u at ${q}, book it?`,
      (q) => `${q} works on my end. want to book it?`,
    ]),
    neutral: Object.freeze([
      (q) => `I can do ${q}. Want me to book it?`,
      (q) => `I can meet you at ${q}. Should I book it?`,
      (q) => `${q} is fine on my end. Want to book it?`,
      (q) => `I can get you ${q}. Shall I book it?`,
    ]),
    formal: Object.freeze([
      (q) => `I can accommodate ${q}. Would you like me to book it?`,
      (q) => `I am able to meet you at ${q}. Shall I proceed with booking?`,
      (q) => `${q} is acceptable to us. Would you like to book it?`,
      (q) => `We can do ${q}. Shall I book the load for you?`,
    ]),
  }),
  // The offer reaches the ceiling for the first time.
  maxFirst: Object.freeze({
    casual: Object.freeze([
      (q) => `best i can do is ${q}, thats my max.`,
      (q) => `${q} is the most i can do on this one.`,
      (q) => `i'm tapped out at ${q}.`,
      (q) => `thats as far as i can go, ${q}.`,
    ]),
    neutral: Object.freeze([
      (q) => `Best I can do is ${q}. That's my max.`,
      (q) => `${q} is the most I can do on this one.`,
      (q) => `I'm at my limit with ${q}.`,
      (q) => `That's as far as I can go: ${q}.`,
    ]),
    formal: Object.freeze([
      (q) => `The best I am able to do is ${q}. That is my maximum.`,
      (q) => `${q} is the most I can offer on this load.`,
      (q) => `I have reached my limit at ${q}.`,
      (q) => `That is as far as I am able to go: ${q}.`,
    ]),
  }),
  // Already at the ceiling and pushed again.
  maxAgain: Object.freeze({
    casual: Object.freeze([
      (q) => `${q} is as high as i can go.`,
      (q) => `still ${q}, cant go higher.`,
      (q) => `i'm at ${q}, thats it for me.`,
      (q) => `no more room, ${q} is it.`,
    ]),
    neutral: Object.freeze([
      (q) => `${q} is as high as I can go.`,
      (q) => `Still ${q}. I can't go higher.`,
      (q) => `I'm at ${q}, and that's it for me.`,
      (q) => `There's no more room. ${q} is it.`,
    ]),
    formal: Object.freeze([
      (q) => `${q} is as high as I am able to go.`,
      (q) => `Our offer remains ${q}. I cannot go higher.`,
      (q) => `I am at ${q}, which is my limit.`,
      (q) => `There is no further room. ${q} is final.`,
    ]),
  }),
  // The carrier is leaving and the broker makes one last offer.
  walkCounter: Object.freeze({
    casual: Object.freeze([
      (q) => `before u go, i can do ${q}. work for u?`,
      (q) => `hold up, i can do ${q}. that ok?`,
      (q) => `wait, ${q} is doable. interested?`,
      (q) => `let me try ${q}, would that work?`,
    ]),
    neutral: Object.freeze([
      (q) => `Before you go, I can do ${q}. Would that work?`,
      (q) => `Hold on, I can do ${q}. Is that any better?`,
      (q) => `Wait, I can get to ${q}. Interested?`,
      (q) => `Let me try ${q}. Would that work?`,
    ]),
    formal: Object.freeze([
      (q) => `Before you go, I can offer ${q}. Would that work for you?`,
      (q) => `If I may, I can do ${q}. Would that be of interest?`,
      (q) => `Please allow me to offer ${q}. Would that suit you?`,
      (q) => `I can improve our offer to ${q}. Would that work?`,
    ]),
  }),
  // The carrier accepts a quote they have not seen yet.
  confirmOffer: Object.freeze({
    casual: Object.freeze([
      (q) => `my offer is ${q}. u good with that?`,
      (q) => `i'm at ${q}. can u confirm that rate?`,
      (q) => `just to be clear, ${q}. that the rate u want?`,
      (q) => `${q} is what i have. u ok with it?`,
    ]),
    neutral: Object.freeze([
      (q) => `My offer is ${q}. Can you confirm that rate?`,
      (q) => `I'm at ${q}. Are you good with that?`,
      (q) => `Just to be clear, it's ${q}. Is that the rate you want?`,
      (q) => `${q} is what I have. Are you okay with it?`,
    ]),
    formal: Object.freeze([
      (q) => `Our offer is ${q}. Could you please confirm that rate?`,
      (q) => `We are at ${q}. Are you comfortable with that?`,
      (q) => `To be clear, the rate is ${q}. Is that what you intend?`,
      (q) => `${q} is our current offer. Would you like to proceed on that basis?`,
    ]),
  }),
  // A figure outside what this load could ever pay.
  invalidFigure: Object.freeze({
    casual: Object.freeze([
      (q) => `that figure is off for this load. i'm at ${q}.`,
      (q) => `cant do that figure. my offer is ${q}.`,
      (q) => `that figure wont work here, i have ${q}.`,
      (q) => `not sure where that figure came from. i'm at ${q}.`,
    ]),
    neutral: Object.freeze([
      (q) => `I can't do that figure. My offer is ${q}.`,
      (q) => `That figure doesn't fit this load. I'm at ${q}.`,
      (q) => `That figure won't work here. I have ${q}.`,
      (q) => `I'm not sure that figure fits this lane. I'm at ${q}.`,
    ]),
    formal: Object.freeze([
      (q) => `I cannot do that figure. My offer is ${q}.`,
      (q) => `That figure is not workable for this load. Our offer is ${q}.`,
      (q) => `I am unable to use that figure. We are at ${q}.`,
      (q) => `That figure does not fit this lane. Our offer is ${q}.`,
    ]),
  }),
})
