import os
from dotenv import load_dotenv
from google import genai

# Load your existing .env file
load_dotenv()

api_key = os.getenv("GEMINI_API_KEY")

if not api_key:
    raise ValueError("GEMINI_API_KEY not found in .env")

client = genai.Client(api_key=api_key)

try:
    response = client.models.generate_content(
        model="gemini-3.6-flash",
        contents="Write a one-line HTML heading that says Hello World."
    )

    print("SUCCESS!")
    print(response.text)

except Exception as e:
    print("GEMINI API FAILED")
    print(type(e).__name__)
    print(e)