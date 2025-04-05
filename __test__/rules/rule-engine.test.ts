import { Graph } from '@/graph';
import { Rule } from '@/lang/rule-parser';
import { ASTRuleRoot } from '@/lang/ast-transformer';
import { RuleEngine, createRuleEngine } from '@/rules/rule-engine';
import { BindingContext } from '@/lang/condition-evaluator';

describe('RuleEngine', () => {
  let engine: RuleEngine;
  let graph: Graph;

  beforeEach(() => {
    engine = createRuleEngine();
    graph = new Graph();

    // Set up a test graph
    graph.addNode('person1', 'Person', { name: 'Alice' });
    graph.addNode('person2', 'Person', { name: 'Bob' });
    graph.addNode('task1', 'Task', { title: 'Task 1', priority: 'High' });
    graph.addNode('task2', 'Task', { title: 'Task 2', priority: 'Low' });
  });

  test('executeQuery handles basic rule execution', () => {
    const rule: Rule = {
      name: 'TestRule',
      description: 'A test rule',
      priority: 1,
      disabled: false,
      ruleText: 'CREATE (n:NewNode {name: "TestNode"})',
      markdown: '```graphrule\nname: TestRule\ndescription: A test rule\npriority: 1\nCREATE (n:NewNode {name: "TestNode"})\n```'
    };

    const result = engine.executeQuery(graph, rule.ruleText);

    expect(result.success).toBe(true);
    expect(result.matchCount).toBe(1); // One empty binding context for CREATE-only rules
    expect(result.actions).toBeDefined();
    expect(result.actions!.actionResults.length).toBe(1);

    // The rule should have created a new node
    const nodes = graph.getAllNodes();
    expect(nodes.length).toBe(5); // 4 original + 1 new

    // Find the created node
    const newNode = nodes.find(node => node.label === 'NewNode');
    expect(newNode).toBeDefined();
    expect(newNode?.data.name).toBe('TestNode');
  });

  test('executeQuery handles pattern matching with conditions', () => {
    const rule: Rule = {
      name: 'TestRule',
      description: 'A test rule with pattern matching',
      priority: 1,
      disabled: false,
      ruleText: 'MATCH (p:Person) WHERE p.name = "Alice" SET p.status = "Active"',
      markdown: '```graphrule\nname: TestRule\ndescription: A test rule with pattern matching\npriority: 1\nMATCH (p:Person) WHERE p.name = "Alice" SET p.status = "Active"\n```'
    };

    const result = engine.executeQuery(graph, rule.ruleText);

    expect(result.success).toBe(true);
    expect(result.matchCount).toBe(1);
    expect(result.actions).toBeDefined();
    expect(result.actions!.actionResults.length).toBe(1);

    // The rule should have updated Alice's status
    const alice = graph.getNode('person1');
    expect(alice?.data.status).toBe('Active');
  });

  test('executeQuery can execute multiple statements in order', () => {
    // Execute two queries in sequence to test priority ordering
    const firstQuery = 'MATCH (p:Person) SET p.lastUpdatedBy = "FirstRule"';
    const secondQuery = 'MATCH (p:Person) SET p.lastUpdatedBy = "SecondRule"';

    // Execute first query
    const result1 = engine.executeQuery(graph, firstQuery);
    expect(result1.success).toBe(true);
    expect(result1.actions).toBeDefined();

    // Execute second query
    const result2 = engine.executeQuery(graph, secondQuery);
    expect(result2.success).toBe(true);
    expect(result2.actions).toBeDefined();

    // Both person nodes should have lastUpdatedBy="SecondRule" because:
    // The second query overwrote the changes from the first query
    const person1 = graph.getNode('person1');
    const person2 = graph.getNode('person2');
    expect(person1?.data.lastUpdatedBy).toBe('SecondRule');
    expect(person2?.data.lastUpdatedBy).toBe('SecondRule');
  });

  test('executeQueriesFromMarkdown extracts and executes queries from markdown', () => {
    const markdown = `
## Test Rules

\`\`\`graphrule
name: TestRule
description: A test rule
priority: 1

CREATE (n:NewNode {name: "FromMarkdown"})
\`\`\`
    `;

    const results = engine.executeQueriesFromMarkdown(graph, markdown);

    expect(results.length).toBe(1);
    expect(results[0].success).toBe(true);
    expect(results[0].actions).toBeDefined();

    // The rule should have created a new node
    const newNode = graph.findNodes(node => node.data.name === 'FromMarkdown')[0];
    expect(newNode).toBeDefined();
    expect(newNode?.label).toBe('NewNode');
  });

  test('executeQuery runs disabled rules directly', () => {
    // When using executeQuery directly, the disabled flag is not checked
    // This is a change in behavior from the old API
    const rule = 'CREATE (n:NewNode {name: "ShouldExist"})';

    const result = engine.executeQuery(graph, rule);

    // Rule should execute successfully
    expect(result.success).toBe(true);

    // The node should be created because we're running the query directly
    const newNode = graph.findNodes(node => node.data.name === 'ShouldExist')[0];
    expect(newNode).toBeDefined();
    expect(newNode?.label).toBe('NewNode');
  });

  test('executeQuery handles errors in query execution', () => {
    const invalidQuery = 'INVALID SYNTAX';

    const result = engine.executeQuery(graph, invalidQuery);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  // This test specifically targets our fix for comma-separated patterns
  test('executeQuery correctly handles comma-separated patterns with cross-product bindings', () => {
    // Define a query that uses comma-separated patterns: MATCH (p:Person), (t:Task)
    const query = 'MATCH (p:Person), (t:Task) CREATE (p)-[r:WORKS_ON {date: "2023-01-15"}]->(t)';

    const result = engine.executeQuery(graph, query);

    // Verify execution succeeded
    expect(result.success).toBe(true);

    // With 2 people and 2 tasks, we should have 4 binding combinations (2×2=4)
    expect(result.matchCount).toBe(4);
    expect(result.actions).toBeDefined();
    expect(result.actions!.actionResults.length).toBe(4);

    // We should have created 4 relationships
    const edges = graph.getAllEdges();
    expect(edges.length).toBe(4);

    // Each relationship should have the correct type and property
    edges.forEach(edge => {
      expect(edge.label).toBe('WORKS_ON');
      expect(edge.data.date).toBe('2023-01-15');
    });

    // Check that each person is connected to each task
    const person1Edges = graph.getEdgesForNode('person1', 'outgoing');
    const person2Edges = graph.getEdgesForNode('person2', 'outgoing');

    expect(person1Edges.length).toBe(2);
    expect(person2Edges.length).toBe(2);

    // Verify the specific connections using a set of source-target pairs
    const connections = new Set<string>();
    edges.forEach(edge => connections.add(`${edge.source}->${edge.target}`));

    expect(connections.has('person1->task1')).toBe(true);
    expect(connections.has('person1->task2')).toBe(true);
    expect(connections.has('person2->task1')).toBe(true);
    expect(connections.has('person2->task2')).toBe(true);
  });

  test('executeQuery handles the case where one pattern has no matches', () => {
    // Create a query that references a non-existent label
    const query = 'MATCH (p:Person), (c:Category) CREATE (p)-[r:BELONGS_TO]->(c)';

    const result = engine.executeQuery(graph, query);

    // Query should execute successfully but with no matches
    expect(result.success).toBe(true);
    expect(result.matchCount).toBe(0);
    expect(result.actions).toBeDefined();
    expect(result.actions!.actionResults.length).toBe(0);

    // No new relationships should be created
    expect(graph.getAllEdges().length).toBe(0);
  });
});