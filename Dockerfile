FROM python:3.11-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .

RUN useradd --system --no-create-home --uid 10001 app
USER app

ENV PYTHONUNBUFFERED=1
CMD ["python", "main.py"]
