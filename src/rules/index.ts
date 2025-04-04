// src/rules/index.ts
/**
 * @file This file exports the public API for the rules system, including pattern matching,
 * condition evaluation, and rule engine components.
 */

export * from "./types";
export * from "./rule-parser";
export * from "./lexer";

// Export core interfaces
export {
  ConditionEvaluator,
  BindingContext,
  ConditionEvaluatorOptions,
  ConditionEvaluatorImpl,
  BindingContextImpl
} from './condition-evaluator';

// Export the pattern matcher interfaces
export {
  PatternMatcher,
  PatternMatcherOptions
} from './pattern-matcher';

// Export the pattern matcher implementations
export {
  PatternMatcherImpl
} from './pattern-matcher';

// Export the extended pattern matcher with conditions
export {
  PatternMatcherWithConditions
} from './pattern-matcher-with-conditions';

// /**
//  * Creates a new pattern matcher with condition evaluation support.
//  * This is the recommended way to create a pattern matcher for most use cases.
//  * 
//  * @param options Options for pattern matching behavior
//  * @param evaluatorOptions Options for condition evaluation behavior
//  * @returns A pattern matcher with condition evaluation support
//  * 
//  * @example
//  * ```typescript
//  * import { createPatternMatcher } from './rules';
//  * 
//  * const matcher = createPatternMatcher({
//  *   caseSensitiveLabels: false
//  * }, {
//  *   enableTypeCoercion: true
//  * });
//  * 
//  * const matches = matcher.findMatchingNodesWithCondition(
//  *   graph,
//  *   { labels: ['task'], properties: {} },
//  *   { type: 'comparison', ... } // Condition
//  * );
//  * ```
//  */
// export function createPatternMatcher<NodeData = any, EdgeData = any>(
//   options?: PatternMatcherOptions,
//   evaluatorOptions?: ConditionEvaluatorOptions
// ): PatternMatcherWithConditions<NodeData, EdgeData> {
//   return new PatternMatcherWithConditions<NodeData, EdgeData>(options, evaluatorOptions);
// }

// /**
//  * Creates a binding context for variable bindings in condition evaluation.
//  * 
//  * @returns A new empty binding context
//  * 
//  * @example
//  * ```typescript
//  * import { createBindingContext } from './rules';
//  * 
//  * const bindings = createBindingContext();
//  * bindings.set('node', myNode);
//  * 
//  * const result = evaluator.evaluateCondition(graph, condition, bindings);
//  * ```
//  */
// export function createBindingContext<NodeData = any, EdgeData = any>(): BindingContext<NodeData, EdgeData> {
//   return new BindingContextImpl<NodeData, EdgeData>();
// }

// /**
//  * Creates a condition evaluator for evaluating expressions.
//  * 
//  * @param options Options for condition evaluation behavior
//  * @returns A new condition evaluator
//  * 
//  * @example
//  * ```typescript
//  * import { createConditionEvaluator } from './rules';
//  * 
//  * const evaluator = createConditionEvaluator({
//  *   enableTypeCoercion: true
//  * });
//  * 
//  * const result = evaluator.evaluateCondition(graph, condition, bindings);
//  * ```
//  */
// export function createConditionEvaluator<NodeData = any, EdgeData = any>(
//   options?: ConditionEvaluatorOptions
// ): ConditionEvaluator<NodeData, EdgeData> {
//   return new ConditionEvaluatorImpl<NodeData, EdgeData>(options);
// }