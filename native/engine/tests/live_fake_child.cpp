// A stand-in for `premation-engine --live FILE` (test_live_host.cpp): reads the
// settings file and plays a scenario named by its "camera" field —
//   ok      ready, three hand frames, then waits for stdin to close
//   crash   ready, then dies without a word (exit 3)
//   error   an error line, exit 0
#include <cstdio>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>

int main(int argc, char** argv) {
  if (argc < 3 || std::string(argv[1]) != "--live") return 64;
  std::ifstream in(argv[2], std::ios::binary);
  std::stringstream ss;
  ss << in.rdbuf();
  const std::string cfg = ss.str();
  const auto scenario = [&](const char* name) { return cfg.find(std::string("\"camera\":\"") + name + "\"") != std::string::npos; };
  if (scenario("error")) {
    std::cout << R"({"ev":"error","message":"The camera could not be opened: busy"})" << '\n' << std::flush;
    return 0;
  }
  std::cout << R"({"ev":"ready","camera":"Fake Cam","width":640,"height":360,"fps":30})" << '\n' << std::flush;
  if (scenario("crash")) return 3;
  std::string lm;
  for (int k = 0; k < 21; ++k) lm += (k ? "," : "") + std::to_string(0.5) + ",0.25,-0.01";
  for (int seq = 1; seq <= 3; ++seq) {
    std::cout << R"({"ev":"hands","seq":)" << seq << R"(,"latencyMs":42.5,"hands":[{"lm":[)" << lm << R"(],"hd":0.8,"pr":0.97,"pi":0.12}]})"
              << '\n'
              << std::flush;
  }
  char c = 0;
  while (std::cin.get(c)) {
  }
  return 0;
}
