import { Graph, Node, NodeId, Edge, Path } from "@/graph";
import { BindingContext } from "./condition-evaluator";

/**
 * Represents a node pattern in a Cypher query
 * e.g., (variable:Label {property: value})
 */
export interface NodePattern {
  /** Variable name to reference the node (optional) */
  variable?: string;
  /** Node labels (optional) */
  labels: string[];
  /** Property constraints (optional) */
  properties: Record<string, string | number | boolean | null>;
}

/**
 * Represents a relationship pattern in a Cypher query
 * e.g., -[variable:TYPE {property: value}]->
 */
export interface RelationshipPattern {
  /** Variable name to reference the relationship (optional) */
  variable?: string;
  /** Relationship type (optional) */
  type?: string;
  /** Property constraints (optional) */
  properties: Record<string, string | number | boolean | null>;
  /** Direction of the relationship: 'outgoing' (->), 'incoming' (<-), or 'both' (-) */
  direction: 'outgoing' | 'incoming' | 'both';
  /** Min path length for variable-length relationships (optional) */
  minHops?: number;
  /** Max path length for variable-length relationships (optional) */
  maxHops?: number;
}

/**
 * Represents a path pattern in a Cypher query
 * e.g., (a)-[:CONTAINS]->(b)
 */
export interface PathPattern {
  /** Starting node pattern */
  start: NodePattern;
  /** Array of relationships and nodes that form the path */
  segments: Array<{
    relationship: RelationshipPattern;
    node: NodePattern;
  }>;
}


/**
 * Options for the pattern matcher
 */
export interface PatternMatcherOptions {
  /**
   * Whether to use case-sensitive matching for labels
   * @default false
   */
  caseSensitiveLabels?: boolean;

  /**
   * Whether to enable property type coercion (e.g., string "42" matches number 42)
   * @default false
   */
  enableTypeCoercion?: boolean;

  /**
   * Maximum depth for variable-length paths to avoid excessive computation
   * @default 10
   */
  maxPathDepth?: number;

  /**
   * Maximum number of paths to return for variable-length path queries
   * @default 100
   */
  maxPathResults?: number;
}


/**
 * Implementation of the pattern matcher
 */
export class PatternMatcher<NodeData = any, EdgeData = any> {
  private options: Required<PatternMatcherOptions>;

  // Cache for node labels
  private labelCache: Map<string, NodeId[]> = new Map();

  // Cache for relationship types
  private typeCache: Map<string, Array<[NodeId, NodeId, string]>> = new Map();

  constructor(options: PatternMatcherOptions = {}) {
    this.options = {
      caseSensitiveLabels: options.caseSensitiveLabels ?? false,
      enableTypeCoercion: options.enableTypeCoercion ?? false,
      maxPathDepth: options.maxPathDepth ?? 10, // Default max depth for safety
      maxPathResults: options.maxPathResults ?? 1000, // Limit results
    };
  }

  /**
   * Finds nodes in the graph that match the given node pattern
   * @param graph The graph to search
   * @param pattern The node pattern to match
   * @returns Array of matching nodes
   */
  findMatchingNodes(
    graph: Graph<NodeData, EdgeData>,
    pattern: NodePattern
  ): Node<NodeData>[] {
    if (pattern.labels && pattern.labels.length > 0) {
      const labeledNodes = this.getNodesByLabel(graph, pattern.labels[0]);
      return labeledNodes.filter(node => this.matchesNodePattern(node, pattern));
    }
    return graph.findNodes(node => this.matchesNodePattern(node, pattern));
  }

  /**
   * Checks if a specific node matches the given node pattern
   * @param node The node to check
   * @param pattern The node pattern to match against
   * @returns True if the node matches the pattern
   */
  matchesNodePattern(
    node: Node<NodeData>,
    pattern: NodePattern
  ): boolean {
    if (pattern.labels && pattern.labels.length > 0) {
      const nodeLabels = this.getNodeLabels(node);
      for (const requiredLabel of pattern.labels) {
        if (!this.labelMatches(nodeLabels, requiredLabel)) {
          return false;
        }
      }
    }
    if (pattern.properties && Object.keys(pattern.properties).length > 0) {
      return this.nodePropertiesMatch(node, pattern.properties);
    }
    return true;
  }

  /**
   * Creates a filtered view of nodes by label
   * @param graph The graph to filter
   * @param label The label to filter by
   * @returns Array of nodes with the given label
   */
  getNodesByLabel(
    graph: Graph<NodeData, EdgeData>,
    label: string
  ): Node<NodeData>[] {
    const normalizedLabel = this.normalizeLabel(label);
    let nodeIds = this.labelCache.get(normalizedLabel);
    if (!nodeIds) {
      const matchingNodes = graph.findNodes(node =>
        this.labelMatches(this.getNodeLabels(node), label)
      );
      nodeIds = matchingNodes.map(node => node.id);
      this.labelCache.set(normalizedLabel, nodeIds);
    }
    return nodeIds
      .map(id => graph.getNode(id))
      .filter((node): node is Node<NodeData> => node !== undefined);
  }


  /**
   * Finds relationships in the graph that match the given relationship pattern
   * @param graph The graph to search
   * @param pattern The relationship pattern to match
   * @param sourceId Optional source node ID to filter relationships
   * @returns Array of matching relationships
   */
  findMatchingRelationships(
    graph: Graph<NodeData, EdgeData>,
    pattern: RelationshipPattern,
    sourceId?: NodeId
  ): Edge<EdgeData>[] {
    // Specialized case when we have a source node ID
    if (sourceId) {
      const sourceNode = graph.getNode(sourceId);
      if (!sourceNode) return [];

      // Get edges directly using the pattern direction
      const edges = graph.getEdgesForNode(sourceId, pattern.direction);

      return edges.filter(edge => {
        // Type check first as it's a fast filter
        if (pattern.type && !this.typeMatches(edge.label, pattern.type)) {
          return false;
        }

        const { sourceNode: edgeSourceNode, targetNode: edgeTargetNode } =
          this.getEndpointNodes(graph, edge);
        if (!edgeSourceNode || !edgeTargetNode) return false;

        // Adjust check for incoming when sourceId is specified
        if (pattern.direction === 'incoming' && edge.target === sourceId) {
          const reversePattern: RelationshipPattern = { ...pattern, direction: 'outgoing' };
          return this.matchesRelationshipPattern(edge, reversePattern, edgeSourceNode, edgeTargetNode);
        }

        return this.matchesRelationshipPattern(edge, pattern, edgeSourceNode, edgeTargetNode);
      });
    }

    // Optimization for type-based filtering
    if (pattern.type) {
      const typedEdges = this.getRelationshipsByType(graph, pattern.type);
      return this.filterEdgesByPattern(graph, typedEdges,
        { ...pattern, type: undefined }); // Skip re-checking type
    }

    // General case - check all edges
    return graph.findEdges(edge => {
      const { sourceNode, targetNode } = this.getEndpointNodes(graph, edge);
      if (!sourceNode || !targetNode) return false;
      return this.matchesRelationshipPattern(edge, pattern, sourceNode, targetNode);
    });
  }

  /**
   * Helper method to get both endpoint nodes for an edge
   * @private
   */
  private getEndpointNodes(
    graph: Graph<NodeData, EdgeData>,
    edge: Edge<EdgeData>
  ): { sourceNode: Node<NodeData> | undefined, targetNode: Node<NodeData> | undefined } {
    return {
      sourceNode: graph.getNode(edge.source),
      targetNode: graph.getNode(edge.target)
    };
  }

  /**
   * Helper to filter edges by a relationship pattern
   * @private
   */
  private filterEdgesByPattern(
    graph: Graph<NodeData, EdgeData>,
    edges: Edge<EdgeData>[],
    pattern: RelationshipPattern
  ): Edge<EdgeData>[] {
    return edges.filter(edge => {
      const { sourceNode, targetNode } = this.getEndpointNodes(graph, edge);
      if (!sourceNode || !targetNode) return false;
      return this.matchesRelationshipPattern(edge, pattern, sourceNode, targetNode);
    });
  }

  /**
   * Checks if a specific relationship matches the given relationship pattern
   * @param edge The edge to check
   * @param pattern The relationship pattern to match against
   * @param sourceNode Optional source node of the relationship
   * @param targetNode Optional target node of the relationship
   * @returns True if the relationship matches the pattern
   */
  matchesRelationshipPattern(
    edge: Edge<EdgeData>,
    pattern: RelationshipPattern,
    sourceNode?: Node<NodeData>,
    targetNode?: Node<NodeData>
  ): boolean {
    // Check type
    if (pattern.type && !this.typeMatches(edge.label, pattern.type)) {
      return false;
    }

    // Check direction
    if (sourceNode && targetNode && pattern.direction !== 'both') {
      if (!this.hasCorrectDirection(edge, pattern, sourceNode, targetNode)) {
        return false;
      }
    }

    // Check properties
    if (pattern.properties && Object.keys(pattern.properties).length > 0) {
      if (!this.edgePropertiesMatch(edge, pattern.properties)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Checks if an edge has the correct direction based on the pattern
   * @private
   */
  private hasCorrectDirection(
    edge: Edge<EdgeData>,
    pattern: RelationshipPattern,
    sourceNode: Node<NodeData>,
    targetNode: Node<NodeData>
  ): boolean {
    if (pattern.direction === 'outgoing') {
      return edge.source === sourceNode.id && edge.target === targetNode.id;
    } else if (pattern.direction === 'incoming') {
      return edge.target === sourceNode.id && edge.source === targetNode.id;
    }
    return true; // 'both' direction always matches
  }

  /**
   * Creates a filtered view of relationships by type
   * @param graph The graph to filter
   * @param type The relationship type to filter by
   * @returns Array of relationships with the given type
   */
  getRelationshipsByType(
    graph: Graph<NodeData, EdgeData>,
    type: string
  ): Edge<EdgeData>[] {
    // Implementation from previous example...
    const normalizedType = this.normalizeLabel(type);
    let edgeIdentifiers = this.typeCache.get(normalizedType);
    if (!edgeIdentifiers) {
      const matchingEdges = graph.findEdges(edge =>
        this.typeMatches(edge.label, type)
      );
      edgeIdentifiers = matchingEdges.map(edge => [
        edge.source,
        edge.target,
        edge.label
      ]);
      this.typeCache.set(normalizedType, edgeIdentifiers);
    }
    return edgeIdentifiers
      .map(([source, target, label]) => graph.getEdge(source, target, label))
      .filter((edge): edge is Edge<EdgeData> => edge !== undefined);
  }


  /**
   * Clears any internal caches
   */
  clearCache(): void {
    this.labelCache.clear();
    this.typeCache.clear();
  }

  // --- Helper Methods (getNodeLabels, labelMatches, typeMatches, etc.) ---
  private getNodeLabels(node: Node<NodeData>): string[] {
    // For now we only support nodes with a single label, but we keep 
    // it as an array for future extension
    return [node.label];
  }

  private labelMatches(nodeLabels: string[], requiredLabel: string): boolean {
    const normalizedRequired = this.normalizeLabel(requiredLabel);
    return nodeLabels.some(label =>
      this.normalizeLabel(label) === normalizedRequired
    );
  }

  private typeMatches(relationshipType: string, requiredType: string): boolean {
    return this.normalizeLabel(relationshipType) === this.normalizeLabel(requiredType);
  }

  private normalizeLabel(label: string): string {
    return this.options.caseSensitiveLabels ? label : label.toLowerCase();
  }

  private nodePropertiesMatch(
    node: Node<NodeData>,
    requiredProps: Record<string, any>
  ): boolean {
    if (!node.data || typeof node.data !== 'object' || node.data === null) {
      return Object.keys(requiredProps).length === 0;
    }
    const nodeData = node.data as Record<string, any>;
    for (const [key, requiredValue] of Object.entries(requiredProps)) {
      // Special case for 'id' property - compare directly with node.id
      if (key === 'id') {
        if (node.id !== requiredValue) {
          return false;
        }
      } else if (!(key in nodeData) || !this.valuesMatch(nodeData[key], requiredValue)) {
        return false;
      }
    }
    return true;
  }

  private edgePropertiesMatch(
    edge: Edge<EdgeData>,
    requiredProps: Record<string, any>
  ): boolean {
    if (!edge.data || typeof edge.data !== 'object' || edge.data === null) {
      return Object.keys(requiredProps).length === 0;
    }
    const edgeData = edge.data as Record<string, any>;
    for (const [key, requiredValue] of Object.entries(requiredProps)) {
      if (!(key in edgeData) || !this.valuesMatch(edgeData[key], requiredValue)) {
        return false;
      }
    }
    return true;
  }

  private valuesMatch(actual: any, expected: any): boolean {
    if (actual === expected) return true;

    if (this.options.enableTypeCoercion) {
      if (typeof expected === 'number' && typeof actual === 'string') {
        return parseFloat(actual) === expected;
      }
      if (typeof expected === 'string' && typeof actual === 'number') {
        return actual.toString() === expected;
      }
      if (typeof expected === 'boolean') {
        const actualStr = String(actual).toLowerCase();
        if (expected === true && (actual === 1 || actualStr === 'true')) return true;
        if (expected === false && (actual === 0 || actualStr === 'false')) return true;
      }
      // Add other coercions if needed (e.g., string to boolean)
    }
    // Special case: Check if required property value exists in an array property
    if (Array.isArray(actual) && !Array.isArray(expected)) {
      return actual.some(item => this.valuesMatch(item, expected));
    }

    return false; // Default to strict equality if no coercion applies
  }

  /**
   * Enriches a pattern with bound variables from the binding context
   * This allows us to constrain pattern matching based on variables bound at any position
   * in the pattern, not just the start node.
   * 
   * @param pattern The original path pattern
   * @param bindings The binding context containing bound variables
   * @returns A new pattern with constraints from bound variables
   */
  enrichPatternWithBindings<NodeData = any, EdgeData = any>(
    pattern: PathPattern,
    bindings: BindingContext<NodeData, EdgeData>
  ): PathPattern {
    // Create a deep clone of the pattern to avoid mutating the original
    const enrichedPattern: PathPattern = {
      start: { ...pattern.start, properties: { ...pattern.start.properties } },
      segments: pattern.segments.map(segment => ({
        relationship: { 
          ...segment.relationship, 
          properties: { ...segment.relationship.properties } 
        },
        node: { 
          ...segment.node, 
          properties: { ...segment.node.properties } 
        }
      }))
    };

    // Check if start node variable is bound
    if (pattern.start.variable && bindings.has(pattern.start.variable)) {
      const boundNode = bindings.get(pattern.start.variable) as Node<NodeData>;
      if (boundNode && boundNode.id) {
        // Add an 'id' property to uniquely identify this node
        enrichedPattern.start.properties = { 
          ...enrichedPattern.start.properties, 
          id: boundNode.id 
        };
      }
    }

    // Check if any segment node variables are bound
    pattern.segments.forEach((segment, index) => {
      if (segment.node.variable && bindings.has(segment.node.variable)) {
        const boundNode = bindings.get(segment.node.variable) as Node<NodeData>;
        if (boundNode && boundNode.id) {
          // Add an 'id' property to uniquely identify this node
          enrichedPattern.segments[index].node.properties = { 
            ...enrichedPattern.segments[index].node.properties, 
            id: boundNode.id 
          };
        }
      }
      
      // Optionally, we could also handle bound relationship variables here,
      // but for the current issue we're focusing on nodes
    });

    return enrichedPattern;
  }

  /**
   * Finds paths in the graph that match the given path pattern
   * @param graph The graph to search
   * @param pattern The path pattern to match
   * @returns Array of matching paths, where each path contains arrays of nodes and edges
   */
  findMatchingPaths(
    graph: Graph<NodeData, EdgeData>,
    pattern: PathPattern
  ): Array<Path<NodeData, EdgeData>> {

    const results: Array<Path<NodeData, EdgeData>> = [];
    // Basic validation
    if (!pattern || !pattern.start) {
      console.warn("Invalid PathPattern: Missing start node pattern.");
      return results;
    }
    const segments = pattern.segments || [];

    // Find matching nodes for the start pattern
    let initialNodes = this.findMatchingNodes(graph, pattern.start);
    
    // If the pattern has an ID property constraint, make sure it's enforced strictly
    if (pattern.start.properties && 'id' in pattern.start.properties) {
      const nodeId = pattern.start.properties.id;
      initialNodes = initialNodes.filter(node => node.id === nodeId);
    }

    // Handle patterns with only a start node
    if (segments.length === 0) {
      return initialNodes.map(node => ({ nodes: [node], edges: [] }));
    }
    
    // NOTE: The previous version had a startNodeIds parameter which is now
    // removed in favor of the more generic enrichPatternWithBindings approach

    // State definition for BFS queue
    interface QueueState {
      currentNode: Node<NodeData>;
      currentPath: Path<NodeData, EdgeData>;
      segmentIdx: number;
      varHopCount: number;
      visitedInPath: Set<NodeId>; // Nodes visited in *this specific path expansion*
    }

    for (const startNode of initialNodes) {
      const queue: QueueState[] = [{
        currentNode: startNode,
        currentPath: { nodes: [startNode], edges: [] },
        segmentIdx: 0,
        varHopCount: 0,
        visitedInPath: new Set([startNode.id]),
      }];
      let bfsIterations = 0; // Safety break

      while (queue.length > 0 && results.length < this.options.maxPathResults) {
        if (++bfsIterations > 100000) {
          console.warn(`[DEBUG] BFS Limit reached for start ${startNode.id}`);
          break;
        }

        const currentState = queue.shift()!;
        const { currentNode, currentPath, segmentIdx, varHopCount, visitedInPath } = currentState;

        // console.log(`\n[DEBUG] Dequeue: Node=${currentNode.id}, PathLen=${currentPath.edges.length}, SegIdx=${segmentIdx}, VarHop=${varHopCount}, Visited=[${Array.from(visitedInPath).join(',')}]`);


        if (segmentIdx >= segments.length) {
          // console.log(`[DEBUG]  -> Skipping: segmentIdx out of bounds.`);
          continue;
        }

        const currentSegment = segments[segmentIdx];
        const currentRelPattern = currentSegment.relationship;
        const targetNodePattern = currentSegment.node; // Node pattern for *this segment's end*

        // Determine Hop Constraints and Variability
        const minHops = currentRelPattern.minHops ?? 1;
        const maxHopsSpecified = currentRelPattern.maxHops; // Keep as undefined if not specified
        // It's variable if the range isn't exactly 1..1 (including undefined max)
        const isVariable = !(minHops === 1 && maxHopsSpecified === 1);

        // Effective maxHops for traversal step limit (avoid infinite loops)
        const maxHopsTraversal = maxHopsSpecified !== undefined
          ? Math.min(maxHopsSpecified, this.options.maxPathDepth)
          // For unbounded '*', cap traversal depth reasonably
          : this.options.maxPathDepth;


        // Check global path depth first
        if (currentPath.edges.length >= this.options.maxPathDepth) {
          // console.log(`[DEBUG]  -> Skipping: Max depth reached.`);
          continue;
        }

        const isFinalSegment = segmentIdx + 1 >= segments.length;

        // console.log(`[DEBUG]  -> Trying Segment ${segmentIdx}: Rel=${currentRelPattern.type || 'ANY'}(${minHops}..${maxHopsSpecified ?? 'inf'}), TargetNode=${targetNodePattern.labels?.[0] || 'ANY'}, isVariable=${isVariable}, isFinal=${isFinalSegment}`);

        const candidateEdges = this.getCandidateEdges(graph, currentNode.id, currentRelPattern.direction);
        // console.log(`[DEBUG]  -> Found ${candidateEdges.length} candidate edges from ${currentNode.id}`);

        for (const edge of candidateEdges) {
          const neighborNode = this.getNeighborNode(graph, currentNode.id, edge, currentRelPattern.direction);
          if (!neighborNode) continue;

          // console.log(`[DEBUG]  --> Edge: ${edge.source}-${edge.label}->${edge.target}, Neighbor: ${neighborNode.id}`);

          // --- Match Relationship Pattern ---
          if (!this.matchesRelationshipPattern(edge, currentRelPattern, currentNode, neighborNode)) {
            // console.log(`[DEBUG]      -> Relationship NO MATCH`);
            continue;
          }
          // console.log(`[DEBUG]      -> Relationship MATCHED`);

          const newHopCount = varHopCount + 1; // Hops within *this* variable segment attempt

          // --- Prepare potential next path state ---
          const newPath: Path<NodeData, EdgeData> = {
            nodes: [...currentPath.nodes, neighborNode],
            edges: [...currentPath.edges, edge],
          };
          // Create a *new* visited set for the next state's branch
          const newVisited = new Set(visitedInPath).add(neighborNode.id);

          // --- Cycle Check (for continuing exploration) ---
          // This check prevents queueing states that would revisit a node already in *this specific path's history*
          const wouldCycle = visitedInPath.has(neighborNode.id);
          // console.log(`[DEBUG]      -> Cycle Check for Continuation: wouldCycle=${wouldCycle}`);

          // --- Check if neighbor matches the target node pattern for *this segment* ---
          // Special check for ID property constraints first - if there's an ID constraint,
          // we need to verify it strictly before doing other pattern matching
          if (targetNodePattern.properties && 'id' in targetNodePattern.properties) {
            const expectedId = targetNodePattern.properties.id;
            if (neighborNode.id !== expectedId) {
              // If ID doesn't match, continue to the next edge immediately
              // console.log(`[DEBUG]      -> ID constraint mismatch: expected=${expectedId}, actual=${neighborNode.id}`);
              continue;
            }
          }
          
          // If we passed the ID check or there was no ID check, proceed with regular pattern matching
          const matchedTargetNode = this.matchesNodePattern(neighborNode, targetNodePattern);
          // console.log(`[DEBUG]      -> Target Node Check (for Seg ${segmentIdx}): matchedTargetNode=${matchedTargetNode}`);


          // --- Check 1: Does this hop COMPLETE the ENTIRE pattern? ---
          // Must be the final segment, meet min hops, and match the final target node pattern.
          if (isFinalSegment && newHopCount >= minHops && matchedTargetNode) {
            // console.log(`[DEBUG]      -> Action: Potential PATTERN COMPLETE (Hops=${newHopCount})`);
            if (results.length < this.options.maxPathResults) {
              // console.log(`[DEBUG]          --> ADDING PATH: ${newPath.nodes.map(n => n.id).join('->')}`);
              results.push(newPath);
            }
            if (results.length >= this.options.maxPathResults) break; // Break edge loop
            // If variable, it *might* still continue below, so don't 'continue' here.
            if (!isVariable) {
              // console.log(`[DEBUG]          --> Fixed length complete, continuing edge loop.`);
              continue; // Fixed path definitely ends here for this edge.
            } else {
              // console.log(`[DEBUG]          --> Variable length complete, but might also continue.`);
            }
          }

          // --- Check 2: Can we CONTINUE the current variable segment? ---
          // Must be variable, under max hops *for the segment*, and not create a cycle.
          if (isVariable && newHopCount < maxHopsTraversal && !wouldCycle) {
            // console.log(`[DEBUG]      -> Action: Potential VARIABLE CONTINUE (NewHop=${newHopCount}, MaxHops=${maxHopsTraversal})`);
            // Ensure the queue push is inside this block
            queue.push({
              currentNode: neighborNode,
              currentPath: newPath,
              segmentIdx: segmentIdx, // Stay on same segment
              varHopCount: newHopCount,
              visitedInPath: newVisited,
            });
            // console.log(`[DEBUG]          --> QUEUED Variable Continue: Node=${neighborNode.id}, SegIdx=${segmentIdx}, VarHop=${newHopCount}`);
          }

          // --- Check 3: Can we TRANSITION to the NEXT segment? ---
          // Must meet min hops *for current segment*, match the target node *for current segment*,
          // not be the final segment, and not create a cycle.
          if (newHopCount >= minHops && matchedTargetNode && !isFinalSegment && !wouldCycle) {
            // console.log(`[DEBUG]      -> Action: Potential NEXT SEGMENT TRANSITION (NewHop=${newHopCount})`);
            queue.push({
              currentNode: neighborNode,
              currentPath: newPath,
              segmentIdx: segmentIdx + 1, // Advance segment
              varHopCount: 0,           // Reset hop count
              visitedInPath: newVisited,
            });
            // console.log(`[DEBUG]          --> QUEUED Next Segment: Node=${neighborNode.id}, SegIdx=${segmentIdx + 1}`);
          }

          if (results.length >= this.options.maxPathResults) break; // Break edge loop

        } // End edge loop

        if (results.length >= this.options.maxPathResults) break; // Break BFS main loop

      } // End BFS while loop
    } // End initialNodes loop

    // console.log(`[DEBUG] findMatchingPaths finished. Found ${results.length} paths.`);

    // --- Optional Deduplication ---
    const uniquePathsMap = new Map<string, Path<NodeData, EdgeData>>();
    const pathToString = (p: Path<NodeData, EdgeData>) => {
      // Create a consistent string representation (nodes + edge types/ids)
      const nodeIds = p.nodes.map(n => n.id).join(',');
      const edgeIds = p.edges.map(e => `${e.source}-${e.label}-${e.target}`).join(',');
      return `${nodeIds}|${edgeIds}`;
    };

    for (const path of results) {
      const pathStr = pathToString(path);
      if (!uniquePathsMap.has(pathStr)) {
        uniquePathsMap.set(pathStr, path);
      }
    }
    const uniqueResults = Array.from(uniquePathsMap.values());
    // console.log(`[DEBUG] Returning ${uniqueResults.length} unique paths.`);
    return uniqueResults;
    // --- End Optional Deduplication ---

    return results;
  }


  // --- Helper for findMatchingPaths ---

  /**
   * Gets candidate edges based on direction from a node.
   * @private
   */
  private getCandidateEdges(
    graph: Graph<NodeData, EdgeData>,
    nodeId: NodeId,
    direction: RelationshipPattern['direction']
  ): Edge<EdgeData>[] {
    // Ensure direction has a default value if undefined (e.g., 'outgoing' or 'both')
    const effectiveDirection = direction || 'outgoing'; // Default to outgoing if not specified? Or 'both'? Let's align with Cypher's default -> which is outgoing.
    // Adjust based on required default behavior. 'both' might be safer if direction '-' is common. Let's use 'both' for safety if unspecified.
    // const effectiveDirection = direction || 'both';

    return graph.getEdgesForNode(nodeId, effectiveDirection);
  }

  /**
   * Gets the neighbor node at the other end of an edge, respecting directionality *relative to the currentNodeId*.
   * Returns undefined if the edge direction doesn't align with the required pattern direction from currentNodeId.
   * @private
   */
  private getNeighborNode(
    graph: Graph<NodeData, EdgeData>,
    currentNodeId: NodeId,
    edge: Edge<EdgeData>,
    patternDirection: RelationshipPattern['direction']
  ): Node<NodeData> | undefined {

    const effectiveDirection = patternDirection || 'outgoing'; // Default if unspecified

    let neighborId: NodeId | null = null;

    if (edge.source === currentNodeId && (effectiveDirection === 'outgoing' || effectiveDirection === 'both')) {
      neighborId = edge.target;
    } else if (edge.target === currentNodeId && (effectiveDirection === 'incoming' || effectiveDirection === 'both')) {
      neighborId = edge.source;
    }

    // If a neighbor ID was determined based on direction, get the node
    if (neighborId !== null) {
      return graph.getNode(neighborId);
    }

    // If the edge exists but doesn't match the required direction from currentNodeId, return undefined
    return undefined;
  }

} // End PatternMatcher Class