"""PDF → DoclingDocument lossless JSON 캐시.

가속기는 CPU 고정 — Docling rt-detr-v2 레이아웃 모델이 float64 position
embedding을 만들지만 Apple MPS는 float64 미지원이라 변환에서 터진다.
"""

from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

from docling.datamodel.accelerator_options import (
    AcceleratorDevice,
    AcceleratorOptions,
)
from docling.datamodel.base_models import ConversionStatus, InputFormat
from docling.datamodel.pipeline_options import PdfPipelineOptions
from docling.datamodel.settings import settings
from docling.document_converter import DocumentConverter, PdfFormatOption
from docling_core.types.doc import ImageRefMode

# CPU에서는 N개 동시 추론이 코어를 공유 + 모델 N개 로드로 메모리만 N배라 낮게.
DEFAULT_BATCH_CONCURRENCY = 2


@dataclass(frozen=True)
class ExtractOutcome:
    source: Path
    status: ConversionStatus
    output: Path | None


def _build_converter() -> DocumentConverter:
    pipeline_options = PdfPipelineOptions()
    pipeline_options.accelerator_options = AcceleratorOptions(
        device=AcceleratorDevice.CPU,
    )
    return DocumentConverter(
        format_options={
            InputFormat.PDF: PdfFormatOption(pipeline_options=pipeline_options),
        },
    )


def extract_pdfs(
    inputs: Iterable[Path],
    output_dir: Path,
    *,
    batch_concurrency: int = DEFAULT_BATCH_CONCURRENCY,
) -> list[ExtractOutcome]:
    settings.perf.doc_batch_concurrency = batch_concurrency
    output_dir.mkdir(parents=True, exist_ok=True)

    converter = _build_converter()
    outcomes: list[ExtractOutcome] = []
    for conv_res in converter.convert_all(list(inputs), raises_on_error=False):
        src = Path(conv_res.input.file)
        if conv_res.status == ConversionStatus.SUCCESS:
            out = output_dir / f"{src.stem}.json"
            conv_res.document.save_as_json(out, image_mode=ImageRefMode.PLACEHOLDER)
            outcomes.append(ExtractOutcome(src, conv_res.status, out))
        else:
            outcomes.append(ExtractOutcome(src, conv_res.status, None))
    return outcomes
