// Scope clarification only; capability, price and fallback assumptions remain r7's.
export function scopeQuestions084(base){
 const pair=base.pair;
 const instructions=pair.instructions
  .replace("Select the GPT configuration for the assistant's NEXT response to the user, not an answer to the task.","Select the GPT configuration for the whole current user turn, including file discovery, tool use, edits and final verification. Do not answer the task.")
  .replace('Select information_insufficient only when the supplied text does not identify even the next response to perform','Select information_insufficient only when the supplied text does not identify even a next action to perform')
  .replace('Choose resources for the next actionable step, including inspecting available project files and running tests.','An identifiable next action establishes that routing is possible; it does not limit the selected configuration to that first action. Allocate resources for the whole requested turn, including inspecting available project files and running tests.');
 return {pair:{...pair,instructions,criteria:{...pair.criteria,information_insufficient:'No next action can be identified from the supplied task and context, including inspecting named project files or asking a necessary clarification. This is an unidentifiable-task condition, not uncertainty about the eventual answer or unseen implementation.'}}};
}

// Explicit candidate conditions are hypotheses for development validation, not task-to-model rules.
export function profileQuestions084(base, conservative=false){
 const models={
  'gpt-6-luna':'Provisional fit: a bounded task with locally checkable requirements, such as asking necessary clarification questions, preserving supplied facts, inspecting a small project for a targeted edit, or transforming local data against a readable specification. File discovery and use of tests do not alone require a larger model. Not assumed adequate for open-ended design or deeply interacting unknowns.',
  'gpt-6-sol':'Provisional fit: substantive implementation or analysis with several interacting requirements, nontrivial algorithms, or coupled components that exceed a bounded transformation. Tool use or a technical subject alone does not establish this level of difficulty.',
  'gpt-6-astra':'Provisional fit: unusually hard reasoning, subtle invariants, novel proofs, or difficult trade-offs among interacting constraints with substantial rework consequences. A request merely to identify missing information or summarize supplied evidence does not by itself establish this need.'
 };
 if(conservative){
  models['gpt-6-luna']='Provisional fit: short clarification or direct fact handling, and targeted code edits with executable checks of behavior. A short file or a syntax-only check does not establish low difficulty. Not assumed adequate for reconciling revised records, applying multiple dependent state rules and computing grouped totals, or operational handoffs whose many independent constraints must all survive. Unseen files alone are not grounds to abstain; use the task purpose to assess these dependencies.';
  models['gpt-6-sol']='Provisional fit: substantive implementation or analysis, including multi-stage data reconciliation, dependent filters and grouped arithmetic, or operational handoffs with many independent constraints and responsibilities. Numeric output without an executable value check needs careful reconciliation, even for small input files. Simple clarification and behavioral-test-backed targeted edits alone do not establish this need.';
 }
 const efforts={
  low:'Direct transformation or a short clarification with few dependencies.',
  medium:'Several explicit checks, comparisons, or a bounded implementation and verification.',
  high:'Dependent reasoning steps and interacting edge cases requiring careful verification.',
  xhigh:'Many tightly interacting constraints or substantial unresolved reasoning branches.',
  max:'Exceptional reasoning difficulty requiring unusually exhaustive verification.'
 };
 return {pair:{...base.pair,criteria:Object.fromEntries(Object.entries(base.pair.criteria).map(([key,text])=>{
  if(key==='information_insufficient')return [key,text];
  const [model,effort]=key.split('/');return [key,text+' '+models[model]+' Effort condition: '+efforts[effort]];
 }))}};
}
