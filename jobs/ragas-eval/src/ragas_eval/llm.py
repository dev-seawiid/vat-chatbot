import instructor
import litellm
from ragas.llms import llm_factory

from ragas_eval.claude_cli import register

DEFAULT_MODEL = "claude-haiku-4-5"


def make_llm():
    register()
    # Mode.JSON — ragas가 List[Model] 응답을 요구하면 instructor TOOLS는 multiple tool_calls로
    # 변환을 시도하다 실패한다 (instructor 알려진 이슈). JSON 모드가 안정적.
    return llm_factory(
        f"claude_cli/{DEFAULT_MODEL}",
        provider="litellm",
        adapter="litellm",
        client=instructor.from_litellm(litellm.acompletion, mode=instructor.Mode.JSON),
    )
