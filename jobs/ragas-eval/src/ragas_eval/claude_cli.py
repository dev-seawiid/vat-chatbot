from __future__ import annotations

import asyncio
import json
import subprocess
import time
import uuid
from typing import Any

import litellm
from litellm import CustomLLM
from litellm.types.utils import Choices, Message, ModelResponse

_CLAUDE_CLI_TIMEOUT_S = 120


def _flatten_messages(messages: list[dict[str, Any]]) -> tuple[str, str]:
    system_parts: list[str] = []
    body_parts: list[str] = []
    for m in messages:
        role = m.get("role")
        content = m.get("content", "")
        if isinstance(content, list):
            content = "\n".join(part.get("text", "") for part in content if isinstance(part, dict))
        if role == "system":
            system_parts.append(content)
        elif role == "assistant":
            body_parts.append(f"Assistant: {content}")
        else:
            body_parts.append(content if role == "user" else f"{role}: {content}")
    return "\n\n".join(system_parts), "\n\n".join(body_parts)


def _run_claude_cli(prompt: str, system: str, model: str) -> str:
    cmd = ["claude", "-p", prompt, "--model", model, "--output-format", "json"]
    if system:
        cmd.extend(["--append-system-prompt", system])
    proc = subprocess.run(
        cmd, capture_output=True, text=True, check=False, timeout=_CLAUDE_CLI_TIMEOUT_S
    )
    if proc.returncode != 0:
        raise RuntimeError(f"claude CLI exited {proc.returncode}: {proc.stderr.strip()}")
    try:
        return json.loads(proc.stdout).get("result", proc.stdout)
    except json.JSONDecodeError:
        return proc.stdout.strip()


def _build_response(model: str, text: str) -> ModelResponse:
    return ModelResponse(
        id=f"chatcmpl-{uuid.uuid4().hex}",
        choices=[Choices(finish_reason="stop", index=0, message=Message(content=text, role="assistant"))],
        created=int(time.time()),
        model=model,
        object="chat.completion",
    )


class ClaudeCLIProvider(CustomLLM):
    def completion(self, *args: Any, **kwargs: Any) -> ModelResponse:
        model = kwargs["model"].split("/", 1)[-1]
        system, prompt = _flatten_messages(kwargs.get("messages", []))
        return _build_response(model, _run_claude_cli(prompt, system, model))

    async def acompletion(self, *args: Any, **kwargs: Any) -> ModelResponse:
        # subprocess.run은 blocking — ragas 동시 호출이 한 건에 막히지 않게 thread pool로.
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, lambda: self.completion(*args, **kwargs))


def register() -> None:
    handler = ClaudeCLIProvider()
    existing = {entry["provider"] for entry in (litellm.custom_provider_map or [])}
    if "claude_cli" not in existing:
        litellm.custom_provider_map = [
            *(litellm.custom_provider_map or []),
            {"provider": "claude_cli", "custom_handler": handler},
        ]
