/**
 * Subject-Aware Expert Rules for Academic and Computer Science Quizzes
 * Classifies questions by domain and injects targeted algorithmic/domain reasoning guidelines.
 */

export const SUBJECT_DOMAINS = {
  DBMS: 'Database Management Systems',
  OS: 'Operating Systems',
  CN: 'Computer Networks',
  DAA: 'Data Structures & Algorithms',
  TOC: 'Theory of Computation',
  AISC: 'AI & Soft Computing',
  SE: 'Software Engineering & UML',
  MATH: 'Discrete Mathematics & Calculus',
  PROG: 'Programming & Code Execution',
  GENERAL: 'General Science & Engineering'
};

const SUBJECT_KEYWORDS = [
  {
    domain: 'DAA',
    regex: /\b(algorithm|complexity|big-?o|omega|theta|time complexity|space complexity|recurrence|master theorem|recursion|divide and conquer|greedy|dynamic programming|knapsack|dijkstra|bellman|floyd|prim|kruskal|binary search tree|avl|red-black|heap|hash table|graph|dfs|bfs|topological sort|quicksort|mergesort)\b/i
  },
  {
    domain: 'OS',
    regex: /\b(operating system|process|thread|cpu scheduling|round robin|round-robin|fcfs|sjf|priority scheduling|semaphore|mutex|critical section|deadlock|banker'?s|paging|page fault|virtual memory|tlb|segmentation|lru|fifo|page replacement|thrashing|fork|context switch)\b/i
  },
  {
    domain: 'AISC',
    regex: /\b(artificial intelligence|machine learning|neural network|heuristic|a\*\s*search|alpha-beta|minimax|genetic algorithm|fuzzy logic|fuzzy set|membership function|perceptron|backpropagation|activation function|clustering|svm|knn)\b/i
  },
  {
    domain: 'CN',
    regex: /\b(computer network|networking|ip address|ipv4|ipv6|subnet|cidr|subnet mask|routing|router|switch|osi model|tcp|udp|transport layer|mac address|sliding window|go-back-n|selective repeat|crc|checksum|congestion control|flow control|dns|http|arp|icmp|network)\b/i
  },
  {
    domain: 'DBMS',
    regex: /\b(select\b|sql\b|queries|database|table\b|normalization|1nf|2nf|3nf|bcnf|acid\b|transaction|serializab|foreign key|primary key|er diagram|b\+?\s*tree|join\b|inner join|outer join|rdbms|relational schema|relational model|relation [a-z]\b)\b/i
  },
  {
    domain: 'TOC',
    regex: /\b(automata|dfa|nfa|regular expression|regular language|context-free|cfg|pda|pushdown|turing machine|chomsky|pumping lemma|decidab|undecidab|halting problem|grammar|derivation|parse tree)\b/i
  },
  {
    domain: 'SE',
    regex: /\b(software engineering|sdlc|waterfall|agile|scrum|cohesion|coupling|design pattern|singleton|factory|observer|uml|class diagram|use case|sequence diagram|testing|black box|white box|unit testing|integration testing)\b/i
  },
  {
    domain: 'MATH',
    regex: /\b(matrix|determinant|eigenvalue|eigenvector|probability|bayes|permutation|combination|discrete math|graph theory|derivative|integral|limit|differential|modulo|boolean algebra|propositional)\b/i
  },
  {
    domain: 'PROG',
    regex: /\b(python|java|javascript|c\+\+|c\b|class|struct|pointer|function|public static void|def\s+|const\s+|let\s+|var\s+|printf|cout|console\.log|syntax|code output)\b/i
  }
];

/**
 * Detect the academic subject domain from question text and option choices
 */
export function detectSubject(questionText = '', options = []) {
  const combined = `${questionText} ${options.map(o => o.text || '').join(' ')}`.toLowerCase();

  for (const { domain, regex } of SUBJECT_KEYWORDS) {
    if (regex.test(combined)) {
      return domain;
    }
  }
  return 'GENERAL';
}

/**
 * Get domain-specific reasoning rules to guide local LLMs with academic precision
 */
export function getDomainGuidelines(domain) {
  switch (domain) {
    case 'DBMS':
      return `Domain Guidelines (DBMS):
- For SQL: Trace SELECT, WHERE, GROUP BY, HAVING, and JOIN order. Pay close attention to NULL handling.
- For Normalization: Verify functional dependencies (FDs), superkeys, and lossless decomposition.
- For Transactions: Verify ACID properties, strict 2PL, conflict serializability, and precedence graphs.`;

    case 'OS':
      return `Domain Guidelines (Operating Systems):
- For CPU Scheduling: Compute exact Gantt chart times, waiting times, and turnaround times.
- For Memory & Paging: Check virtual to physical address translations, page offset calculation, and replacement order.
- For Deadlock & Synchronization: Check Banker's algorithm safety vectors, semaphore wait/signal (P/V) primitives.`;

    case 'CN':
      return `Domain Guidelines (Computer Networks):
- For Subnetting / CIDR: Calculate network address, broadcast address, prefix length, and usable host count accurately (2^(32-prefix) - 2).
- For Protocols & OSI: Verify layer responsibilities (Transport = reliability/ports, Network = routing/IP).
- For Sliding Window: Utilization = N / (1 + 2a), where a = Tp / Tt.`;

    case 'DAA':
      return `Domain Guidelines (Data Structures & Algorithms):
- For Complexity: Distinguish worst, best, and average cases. Verify Master Theorem condition cases (f(n) vs n^(log_b a)).
- For Graphs & Trees: Track node discovery, edge relaxation, balance factors (AVL), and heap property invariants.
- For Recurrences: Expand steps systematically or apply standard recurrence patterns.`;

    case 'TOC':
      return `Domain Guidelines (Theory of Computation):
- For Automata: Trace strings character-by-character from the initial state to determine if an accepting state is reached.
- For Grammars: Verify unambiguous derivations and Chomsky hierarchy levels (Type 3 Regular ⊂ Type 2 CFL ⊂ Type 1 CSL ⊂ Type 0 RE).
- For Pumping Lemma: Ensure string decomposition rules |xy| <= p and |y| > 0 are respected.`;

    case 'AISC':
      return `Domain Guidelines (AI & Soft Computing):
- For Search: Verify admissible heuristics (h(n) <= h*(n)) and consistency.
- For Neural Nets: Apply exact activation functions (Sigmoid, ReLU, Softmax) and derivative formulas.
- For Fuzzy Logic: Standard t-norm (intersection) is min(A, B); s-norm (union) is max(A, B).`;

    case 'SE':
      return `Domain Guidelines (Software Engineering):
- Distinguish high cohesion (good) from tight coupling (bad).
- For Testing: Cyclomatic complexity V(G) = E - N + 2P = P + 1 (predicate nodes).
- For Design Patterns: Identify the specific Creational, Structural, or Behavioral pattern.`;

    case 'MATH':
      return `Domain Guidelines (Mathematics):
- Solve calculations step-by-step. Double-check arithmetic, signs, powers, and base representations.
- For Matrices: Determinant, trace, and eigenvalue sums (sum(lambda) = trace, prod(lambda) = det).`;

    case 'PROG':
      return `Domain Guidelines (Programming):
- Trace execution step-by-step tracking variable values, loop counters, zero-indexing, and boundary conditions.
- Pay attention to pass-by-value vs pass-by-reference and operator precedence.`;

    default:
      return `Domain Guidelines:
- Analyze the fundamental principles of the question.
- Perform any calculation step-by-step and verify against the options.`;
  }
}
