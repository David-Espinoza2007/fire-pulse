# FirePulse as a container (written for a Hugging Face Docker Space; see deploy_space.py).
# The data is not in the image source: the build downloads it from the dataset repository named in the file DATA_REPO.
FROM python:3.13-slim
RUN useradd -m -u 1000 user
USER user
ENV HOME=/home/user PATH=/home/user/.local/bin:$PATH PYTHONUNBUFFERED=1
WORKDIR /home/user/app
COPY --chown=user requirements.txt .
RUN pip install --no-cache-dir --user duckdb fastapi uvicorn huggingface_hub \
 && python -c "import duckdb; duckdb.connect().execute('INSTALL spatial')"
# DATA_REPO holds "owner/name@commit": a new commit of the data changes this file, so this layer is built again
COPY --chown=user DATA_REPO .
RUN python -c "from huggingface_hub import snapshot_download; r, v = open('DATA_REPO').read().strip().split('@'); snapshot_download(r, repo_type='dataset', revision=v, local_dir='data')" \
 && rm -rf data/.cache && touch -d 2000-01-01 data/world/serve/monthly.parquet
COPY --chown=user . .
# tiles.py rebuilds a cached tile that is older than monthly.parquet or tiles.py; the download gives the files new dates, so set these two back
RUN touch -d 2000-01-01 tiles.py
EXPOSE 7860
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7860"]
