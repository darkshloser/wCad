# Python worker image: DXF/LandXML/OGR import-export, LOD builds, reprojection (Phase 3).
# GDAL is installed from Debian rather than built, which keeps the image reproducible and the
# build fast on an air-gapped or bandwidth-limited on-prem network.
FROM python:3.12-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
      gdal-bin libgdal-dev build-essential \
    && rm -rf /var/lib/apt/lists/*

ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
WORKDIR /app

COPY apps/workers/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY apps/workers ./
CMD ["python", "-m", "wcad_workers.main"]
