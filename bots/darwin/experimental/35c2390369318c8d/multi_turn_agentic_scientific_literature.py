# requirements.txt
# numpy>=1.24.0

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from typing import List, Dict, Tuple, Optional
from collections import defaultdict, Counter

import numpy as np


@dataclass
class Paper:
    # 논문 기본 정보
    paper_id: str
    title: str
    abstract: str
    year: int = 0
    metadata: Dict[str, str] = field(default_factory=dict)

    @property
    def text(self) -> str:
        # 검색용 전체 텍스트
        return f"{self.title}. {self.abstract}"


@dataclass
class SearchState:
    # 다중 턴 탐색 상태
    query: str
    turn: int = 0
    history: List[Dict] = field(default_factory=list)
    visited_ids: set = field(default_factory=set)
    evidence_terms: Counter = field(default_factory=Counter)


class SimpleTokenizer:
    # 최소한의 토크나이저
    _token_pattern = re.compile(r"[a-zA-Z가-힣0-9]+")

    @classmethod
    def tokenize(cls, text: str) -> List[str]:
        # 영문 소문자화 후 토큰 추출
        return [t.lower() for t in cls._token_pattern.findall(text)]


class TfidfIndex:
    # 간단한 TF-IDF 검색 인덱스
    def __init__(self, papers: List[Paper]):
        self.papers = papers
        self.doc_tokens: Dict[str, List[str]] = {}
        self.vocab: Dict[str, int] = {}
        self.idf: Dict[str, float] = {}
        self.doc_vectors: Dict[str, np.ndarray] = {}
        self._build()

    def _build(self) -> None:
        # 문서 토큰화 및 DF 계산
        df = Counter()
        docs_tokens = []

        for paper in self.papers:
            tokens = SimpleTokenizer.tokenize(paper.text)
            self.doc_tokens[paper.paper_id] = tokens
            docs_tokens.append((paper.paper_id, tokens))
            for tok in set(tokens):
                df[tok] += 1

        # 어휘 사전 구성
        vocab_terms = sorted(df.keys())
        self.vocab = {term: i for i, term in enumerate(vocab_terms)}

        # IDF 계산
        n_docs = max(1, len(self.papers))
        self.idf = {
            term: math.log((1 + n_docs) / (1 + freq)) + 1.0
            for term, freq in df.items()
        }

        # 각 문서 벡터 계산
        for paper_id, tokens in docs_tokens:
            self.doc_vectors[paper_id] = self._vectorize_tokens(tokens)

    def _vectorize_tokens(self, tokens: List[str]) -> np.ndarray:
        # TF-IDF 벡터화
        vec = np.zeros(len(self.vocab), dtype=np.float32)
        tf = Counter(tokens)
        if not tokens:
            return vec

        for term, count in tf.items():
            idx = self.vocab.get(term)
            if idx is not None:
                vec[idx] = (count / len(tokens)) * self.idf.get(term, 1.0)

        norm = np.linalg.norm(vec)
        if norm > 0:
            vec /= norm
        return vec

    def search(self, query: str, top_k: int = 5, exclude_ids: Optional[set] = None) -> List[Tuple[Paper, float]]:
        # 쿼리와 각 문서의 코사인 유사도 계산
        exclude_ids = exclude_ids or set()
        q_vec = self._vectorize_tokens(SimpleTokenizer.tokenize(query))
        results = []

        for paper in self.papers:
            if paper.paper_id in exclude_ids:
                continue
            score = float(np.dot(q_vec, self.doc_vectors[paper.paper_id]))
            if score > 0:
                results.append((paper, score))

        results.sort(key=lambda x: x[1], reverse=True)
        return results[:top_k]


class WorkflowInductionAgent:
    # 논문 제목의 핵심 아이디어를 단순화한 다중 턴 에이전트 검색기
    # 핵심 개념:
    # 1) 현재 쿼리로 검색
    # 2) 상위 결과에서 중요한 용어 추출
    # 3) 추출한 용어를 기반으로 다음 턴 쿼리 재작성
    # 4) 반복하며 점진적으로 탐색 workflow를 유도

    def __init__(self, index: TfidfIndex, max_turns: int = 3, top_k_per_turn: int = 3):
        self.index = index
        self.max_turns = max_turns
        self.top_k_per_turn = top_k_per_turn
        self.stopwords = {
            "the", "a", "an", "and", "or", "for", "to", "of", "in", "on", "with",
            "via", "using", "from", "by", "at", "is", "are", "we", "this", "that",
            "these", "those", "be", "as", "can", "our", "their", "into", "across",
            "study", "paper", "method", "methods", "approach", "based", "new",
            "multi", "turn", "agentic", "scientific", "literature", "search",
            "workflow", "induction"
        }

    def _extract_salient_terms(self, papers: List[Paper], top_n: int = 5) -> List[str]:
        # 상위 검색 결과에서 중요한 용어 추출
        tf = Counter()
        for paper in papers:
            tokens = SimpleTokenizer.tokenize(paper.title + " " + paper.abstract)
            for tok in tokens:
                if len(tok) >= 3 and tok not in self.stopwords and not tok.isdigit():
                    tf[tok] += 1

        # 자주 등장하는 핵심 용어 선택
        return [term for term, _ in tf.most_common(top_n)]

    def _rewrite_query(self, state: SearchState, new_terms: List[str], max_terms: int = 4) -> str:
        # 기존 쿼리와 새 증거 용어를 합쳐 다음 턴 쿼리 생성
        base_terms = SimpleTokenizer.tokenize(state.query)
        merged = []

        seen = set()
        for tok in base_terms:
            if tok not in seen:
                merged.append(tok)
                seen.add(tok)

        ranked_terms = [
            term for term, _ in state.evidence_terms.most_common()
            if term not in seen
        ]
        for term in new_terms:
            if term not in seen:
                ranked_terms.append(term)

        for term in ranked_terms:
            if term not in seen:
                merged.append(term)
                seen.add(term)
            if len(merged) >= len(base_terms) + max_terms:
                break

        return " ".join(merged)

    def run(self, user_query: str) -> Dict:
        # 전체 다중 턴 탐색 실행
        state = SearchState(query=user_query)
        aggregated_scores = defaultdict(float)
        selected_papers: Dict[str, Paper] = {}

        for turn in range(self.max_turns):
            state.turn = turn + 1

            # 현재 쿼리로 검색
            results = self.index.search(
                state.query,
                top_k=self.top_k_per_turn,
                exclude_ids=state.visited_ids
            )

            if not results:
                state.history.append({
                    "turn": state.turn,
                    "query": state.query,
                    "results": [],
                    "salient_terms": [],
                })
                break

            current_papers = [paper for paper, _ in results]

            # 결과 누적 및 방문 처리
            for rank, (paper, score) in enumerate(results, start=1):
                state.visited_ids.add(paper.paper_id)
                aggregated_scores[paper.paper_id] += score * (1.0 / rank)
                selected_papers[paper.paper_id] = paper

            # 현재 결과에서 핵심 용어 추출
            salient_terms = self._extract_salient_terms(current_papers)
            state.evidence_terms.update(salient_terms)

            state.history.append({
                "turn": state.turn,
                "query": state.query,
                "results": [(p.paper_id, s) for p, s in results],
                "salient_terms": salient_terms,
            })

            # 다음 턴 쿼리 재작성
            next_query = self._rewrite_query(state, salient_terms)
            if next_query == state.query:
                break
            state.query = next_query

        # 최종 결과 정렬
        final_ranked = sorted(
            [(selected_papers[pid], score) for pid, score in aggregated_scores.items()],
            key=lambda x: x[1],
            reverse=True
        )

        return {
            "final_query": state.query,
            "history": state.history,
            "results": final_ranked,
        }


def build_demo_corpus() -> List[Paper]:
    # 간단한 데모용 논문 집합
    return [
        Paper(
            paper_id="P1",
            title="Multi-turn agent systems for literature discovery",
            abstract="We study iterative retrieval agents that refine search queries using evidence from prior results."
        ),
        Paper(
            paper_id="P2",
            title="Scientific document retrieval with query reformulation",
            abstract="This paper presents retrieval for science papers using iterative query expansion and relevance feedback."
        ),
        Paper(
            paper_id="P3",
            title="Workflow induction for autonomous research assistants",
            abstract="Autonomous assistants induce search workflows from multi-step interactions and evidence accumulation."
        ),
        Paper(
            paper_id="P4",
            title="Dense passage retrieval for biomedical literature search",
            abstract="Biomedical retrieval benefits from dense encoders, passage ranking, and domain adaptation."
        ),
        Paper(
            paper_id="P5",
            title="Relevance feedback improves academic search",
            abstract="Interactive search systems improve ranking by extracting salient terms from relevant documents."
        ),
        Paper(
            paper_id="P6",
            title="Planning and tool use in language agents",
            abstract="Language agents combine planning, tool use, and memory to solve multi-step knowledge tasks."
        ),
    ]


if __name__ == "__main__":
    # 예시 실행
    papers = build_demo_corpus()
    index = TfidfIndex(papers)
    agent = WorkflowInductionAgent(index, max_turns=3, top_k_per_turn=2)

    query = "multi-turn scientific literature search agent"
    output = agent.run(query)

    print("최종 쿼리:", output["final_query"])
    print("\n턴별 기록:")
    for step in output["history"]:
        print(f"- Turn {step['turn']}")
        print("  Query:", step["query"])
        print("  Results:", step["results"])
        print("  Salient Terms:", step["salient_terms"])

    print("\n최종 결과:")
    for paper, score in output["results"]:
        print(f"{paper.paper_id}\t{score:.4f}\t{paper.title}")