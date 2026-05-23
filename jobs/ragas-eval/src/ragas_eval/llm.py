import instructor
import litellm
from ragas.llms import llm_factory

DEFAULT_MODEL = "gpt-5-nano"


def make_llm():
    # Mode.JSON — ragas가 List[Model] 응답을 요구할 때 instructor TOOLS는 multiple tool_calls로
    # 변환하다 실패한다(known issue). JSON 모드가 안정적.
    return llm_factory(
        f"openai/{DEFAULT_MODEL}",
        provider="litellm",
        adapter="litellm",
        client=instructor.from_litellm(litellm.acompletion, mode=instructor.Mode.JSON),
    )
