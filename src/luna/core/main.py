# pip install -qU langchain langchain-ollama
from langchain.agents import create_agent
from langchain_ollama import ChatOllama

model = ChatOllama(
    model="llama3.1:8b",
)
agent = create_agent(
    model=model,
    system_prompt="You are a helpful assistant",
)

result = agent.invoke(
    {"messages": [{"role": "user", "content": "What's the weather in agra?"}]}
)

print(result["messages"][-1].content_blocks)