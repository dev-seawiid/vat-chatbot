from ragas.embeddings import LiteLLMEmbeddings


def make_embeddings():
    return LiteLLMEmbeddings("voyage/voyage-3")
