// E2 decode: ffmpeg → conformed source. Sample accuracy of seeks (decode_range
// vs a linear decode, per codec), the resampler's alignment (an impulse lands
// on the right output frame), the Web Audio down-mix, a video without sound,
// the conform → peaks → mix path through AudioSystem.
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <optional>
#include <random>
#include <string>
#include <thread>
#include <vector>

#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include "audio_decode.hpp"
#include "audio_fixture_ffi.hpp"
#include "audio_system.hpp"
#include "external_audio.hpp"
#include "media_fixture_ffi.hpp"
#include "mixer.hpp"
#include "source_store.hpp"
#include "transport_clock.hpp"

using namespace premation::audio;  // NOLINT(google-build-using-namespace)
namespace fs = std::filesystem;

namespace {

fs::path tmp_dir() {
  const fs::path p = fs::temp_directory_path() / "premation_audio_tests";
  fs::create_directories(p);
  return p;
}

std::vector<std::vector<float>> signal(int channels, int frames, int sr, std::uint32_t seed) {
  std::mt19937 g(seed);
  std::uniform_real_distribution<float> d(-0.3F, 0.3F);
  std::vector<std::vector<float>> p(static_cast<std::size_t>(channels), std::vector<float>(static_cast<std::size_t>(frames)));
  for (int c = 0; c < channels; ++c) {
    for (int i = 0; i < frames; ++i) {
      const double t = static_cast<double>(i) / sr;
      p[static_cast<std::size_t>(c)][static_cast<std::size_t>(i)] =
          static_cast<float>(0.4 * std::sin(2 * 3.141592653589793 * (300 + 200 * c) * t)) + d(g) * 0.2F;
    }
  }
  return p;
}

std::string make_file(fixture::Codec codec, const std::string& name, const std::vector<std::vector<float>>& planes, int sr) {
  const fs::path p = tmp_dir() / name;
  std::string error;
  REQUIRE(fixture::write(p.string(), codec, planes, sr, error));
  return p.string();
}

}  // namespace

TEST_CASE("decode: seeking is sample-accurate (WAV, FLAC, AAC/MP4)", "[audio][decode]") {
  const auto planes = signal(2, 96000, 44100, 1);
  struct Case {
    fixture::Codec codec;
    const char* file;
  };
  for (const Case& c : {Case{fixture::Codec::wavPcm16, "seek.wav"}, Case{fixture::Codec::flac, "seek.flac"},
                        Case{fixture::Codec::aacMp4, "seek.mp4"}}) {
    const std::string path = make_file(c.codec, c.file, planes, 44100);
    std::vector<std::vector<float>> all;
    std::string error;
    REQUIRE(decode_all_native(path, all, error));
    REQUIRE(all.size() == 2);
    std::mt19937 g(7);
    std::uniform_int_distribution<std::int64_t> pos(0, static_cast<std::int64_t>(all[0].size()) - 5000);
    std::size_t mismatched = 0;
    std::size_t checked = 0;
    for (int k = 0; k < 12; ++k) {
      const std::int64_t from = k == 0 ? 0 : pos(g);
      std::vector<std::vector<float>> part;
      REQUIRE(decode_range(path, from, 4096, part, error));
      for (std::size_t ch = 0; ch < 2; ++ch) {
        for (std::size_t i = 0; i < 4096; ++i) {
          ++checked;
          if (part[ch][i] != all[ch][static_cast<std::size_t>(from) + i]) ++mismatched;
        }
      }
    }
    INFO(c.file << ": " << mismatched << " of " << checked << " samples differ after seeks");
    CHECK(mismatched == 0);
  }
}

TEST_CASE("decode: conform to 48 kHz keeps time (an impulse lands on its frame)", "[audio][decode]") {
  std::vector<std::vector<float>> planes(1, std::vector<float>(44100, 0.0F));
  planes[0][11025] = 1.0F;  // 0.25 s
  const std::string path = make_file(fixture::Codec::wavFloat, "impulse.wav", planes, 44100);
  AudioStreamInfo info;
  std::string error;
  REQUIRE(probe_audio(path, info, error));
  CHECK(info.channels == 1);
  CHECK(info.sampleRate == 44100);
  SourceData sink(conformed_channels(info.channels), 48000, 48000 * 4);
  REQUIRE(conform_audio(path, 48000, sink, nullptr, error));
  CHECK(sink.total_frames() == 48000);
  std::int64_t peakAt = 0;
  float peak = 0;
  for (std::int64_t i = 0; i < sink.total_frames(); ++i) {
    if (std::fabs(sink.at(0, i)) > peak) {
      peak = std::fabs(sink.at(0, i));
      peakAt = i;
    }
  }
  INFO("impulse at 0.25 s → output frame " << peakAt << " (expected 12000)");
  CHECK(std::llabs(peakAt - 12000) <= 1);
  // A tone keeps its frequency and level through the resampler.
  std::vector<std::vector<float>> sine(1, std::vector<float>(44100));
  for (int i = 0; i < 44100; ++i) sine[0][static_cast<std::size_t>(i)] = static_cast<float>(0.5 * std::sin(2 * 3.141592653589793 * 1000 * i / 44100.0));
  const std::string sp = make_file(fixture::Codec::wavFloat, "sine.wav", sine, 44100);
  SourceData s2(1, 48000, 48000 * 4);
  REQUIRE(conform_audio(sp, 48000, s2, nullptr, error));
  double err = 0;
  double sig = 0;
  for (std::int64_t i = 2000; i < 46000; ++i) {
    const double ref = 0.5 * std::sin(2 * 3.141592653589793 * 1000 * static_cast<double>(i) / 48000.0);
    err += (ref - s2.at(0, i)) * (ref - s2.at(0, i));
    sig += ref * ref;
  }
  const double snr = 10 * std::log10(sig / err);
  INFO("resampled 1 kHz sine SNR " << snr << " dB");
  CHECK(snr > 70);
}

TEST_CASE("decode: 5.1 is down-mixed with the Web Audio speaker rules; mono stays mono", "[audio][decode]") {
  std::vector<std::vector<float>> p(6, std::vector<float>(4800));
  const std::array<float, 6> v{0.1F, 0.2F, 0.3F, 0.05F, 0.4F, 0.25F};  // L R C LFE SL SR
  for (std::size_t c = 0; c < 6; ++c) std::fill(p[c].begin(), p[c].end(), v[c]);
  const std::string path = make_file(fixture::Codec::wavFloat, "surround.wav", p, 48000);
  std::vector<std::vector<float>> out;
  std::string error;
  REQUIRE(decode_all_native(path, out, error));
  REQUIRE(out.size() == 2);
  const double s = std::sqrt(0.5);
  CHECK(out[0][100] == Catch::Approx(0.1 + s * (0.3 + 0.4)).epsilon(1e-5));
  CHECK(out[1][100] == Catch::Approx(0.2 + s * (0.3 + 0.25)).epsilon(1e-5));
  CHECK(conformed_channels(1) == 1);
}

TEST_CASE("decode: a video with no audio track is silent, not an error", "[audio][decode]") {
  premation::media::fixture::Spec spec;
  spec.kind = premation::media::fixture::Kind::mpeg4;
  spec.frames = 5;
  const fs::path p = tmp_dir() / "video_only.mp4";
  std::string error;
  REQUIRE(premation::media::fixture::write(spec, p.string(), error));
  AudioStreamInfo info;
  REQUIRE(probe_audio(p.string(), info, error));
  CHECK_FALSE(info.hasAudio);
  AudioSystem sys(AudioSystemOptions{{48000, 2}, 1, false, 10});
  const std::uint64_t id = sys.open_source(p.string(), error);
  CHECK(id != 0);
  CHECK(sys.state(id) == SourceState::silent);
}

TEST_CASE("AudioSystem: open → conform → peaks → offline mix", "[audio][decode]") {
  const auto planes = signal(2, 44100 * 2, 44100, 9);
  const std::string path = make_file(fixture::Codec::flac, "sys.flac", planes, 44100);
  AudioSystem sys(AudioSystemOptions{{48000, 2}, 2, false, 10});
  std::string error;
  const std::uint64_t id = sys.open_source(path, error);
  REQUIRE(id != 0);
  const SourcePtr src = sys.source(id);
  REQUIRE(src);
  src->wait_for(INT64_MAX);
  for (int i = 0; i < 200 && sys.state(id) != SourceState::ready; ++i) std::this_thread::sleep_for(std::chrono::milliseconds(5));
  CHECK(sys.state(id) == SourceState::ready);
  CHECK(src->total_frames() == 96000);
  const auto pk = sys.peaks(id, 0, 2, 1024, true);
  CHECK(pk.buckets == 1024);
  CHECK(pk.channels == 1);
  Program prog;
  Voice v;
  v.id = "v";
  v.source = id;
  v.startSec = 0.5;
  v.outSec = 1.0;
  prog.voices.push_back(v);
  const auto out = sys.render(prog, 0, 96000);
  CHECK(out[0][23999] == 0);
  CHECK(out[0][24000 + 100] == src->at(0, 100));
  CHECK(out[1][24000 + 100] == src->at(1, 100));
}

TEST_CASE("decode: a file an external reader claims (P7b plugin footage) conforms like a decoded one", "[audio][decode]") {
  // The same stereo 44.1 kHz samples as a float WAV (ffmpeg) and as a claimed ".praw"
  // read through ExternalAudio (what the plugin host installs): same probe, same
  // down-mix and resampler, so the conformed sources match.
  const auto planes = signal(2, 44100, 44100, 21);
  const std::string wav = make_file(fixture::Codec::wavFloat, "external_ref.wav", planes, 44100);
  const std::string claimed = (tmp_dir() / "external.praw").string();
  std::vector<float> interleaved(planes[0].size() * 2);
  for (std::size_t i = 0; i < planes[0].size(); ++i) {
    interleaved[i * 2] = planes[0][i];
    interleaved[i * 2 + 1] = planes[1][i];
  }
  int reads = 0;
  ExternalAudio::set_handlers(
      [](std::string_view p) { return p.ends_with(".praw"); },
      [&](const std::string& p, ExternalAudioFormat& f, std::string& e) {
        if (p != claimed) return e = "unknown file", false;
        f.channels = 2;
        f.sampleRate = 44100;
        f.frames = static_cast<std::int64_t>(planes[0].size());
        f.codec = "PRAW";
        return true;
      },
      [&](const std::string&, std::int64_t start, std::uint32_t frames, std::vector<float>& out, std::string&) {
        ++reads;
        const auto total = static_cast<std::int64_t>(planes[0].size());
        const std::int64_t n = std::clamp<std::int64_t>(total - start, 0, frames);
        out.assign(interleaved.begin() + start * 2, interleaved.begin() + (start + n) * 2);
        return true;
      });
  struct Clear {
    ~Clear() { ExternalAudio::clear_handlers(); }
  } clear;

  AudioStreamInfo info;
  std::string error;
  REQUIRE(probe_audio(claimed, info, error));
  CHECK(info.hasAudio);
  CHECK(info.channels == 2);
  CHECK(info.sampleRate == 44100);
  CHECK(info.durationSec == Catch::Approx(1.0));
  CHECK(info.codec == "PRAW");
  REQUIRE(probe_audio(wav, info, error));  // not claimed: ffmpeg as before
  CHECK(info.codec != "PRAW");

  SourceData ref(2, 48000, 48000 * 4);
  SourceData ext(2, 48000, 48000 * 4);
  REQUIRE(conform_audio(wav, 48000, ref, nullptr, error));
  REQUIRE(conform_audio(claimed, 48000, ext, nullptr, error));
  CHECK(reads > 1);
  REQUIRE(ext.total_frames() == ref.total_frames());
  CHECK(ext.total_frames() == 48000);
  float worst = 0;
  for (int c = 0; c < 2; ++c) {
    for (std::int64_t i = 0; i < ref.total_frames(); ++i) worst = std::max(worst, std::fabs(ext.at(c, i) - ref.at(c, i)));
  }
  INFO("largest difference to the decoded WAV " << worst);
  CHECK(worst < 1e-5F);

  // Random access and the whole-file decode (the audio jobs) read the plugin's samples exactly.
  std::vector<std::vector<float>> range;
  REQUIRE(decode_range(claimed, 1000, 64, range, error));
  REQUIRE(range.size() == 2);
  CHECK(range[1][10] == planes[1][1010]);
  REQUIRE(decode_range(claimed, -10, 20, range, error));
  CHECK(range[0][9] == 0);
  CHECK(range[0][10] == planes[0][0]);
  std::vector<std::vector<float>> all;
  REQUIRE(decode_all_native(claimed, all, error));
  REQUIRE(all.size() == 2);
  CHECK(all[0].size() == planes[0].size());
  CHECK(all[0][44099] == planes[0][44099]);

  // The playback mixer and the export mix (AudioSystem) play it.
  AudioSystem sys(AudioSystemOptions{{48000, 2}, 1, false, 10});
  const std::uint64_t id = sys.open_source(claimed, error);
  REQUIRE(id != 0);
  const SourcePtr src = sys.source(id);
  REQUIRE(src);
  src->wait_for(INT64_MAX);
  for (int i = 0; i < 200 && sys.state(id) != SourceState::ready; ++i) std::this_thread::sleep_for(std::chrono::milliseconds(5));
  CHECK(sys.state(id) == SourceState::ready);
  Program prog;
  Voice v;
  v.id = "v";
  v.source = id;
  v.outSec = 1.0;
  prog.voices.push_back(v);
  const auto out = sys.render(prog, 0, 48000);
  CHECK(out[0][1000] == src->at(0, 1000));
  CHECK(out[0][1000] != 0);

  // A reader error fails that source; the handlers gone, the file is ffmpeg's again (and unreadable).
  ExternalAudio::clear_handlers();
  CHECK_FALSE(ExternalAudio::claims(claimed));
  CHECK_FALSE(probe_audio(claimed, info, error));
}

TEST_CASE("TransportClock over AudioSystem + NullDevice: the Session's clock seam", "[audio][clock]") {
  AudioSystem sys(AudioSystemOptions{{48000, 2}, 1, false, 10});
  std::string error;
  REQUIRE(sys.start_device(error));
  CHECK(sys.device_info().backend == "null");
  std::vector<std::vector<float>> tone(2, std::vector<float>(48000 * 3, 0.1F));
  const std::uint64_t id = sys.add_source(SourceData::from_planes(tone, 48000));
  Program p;
  Voice v;
  v.id = "t";
  v.source = id;
  p.voices.push_back(v);
  sys.set_program(p);
  premation::AudioTransportClock clock(sys);
  clock.play(0.5, 1, LoopMode::loop, 0, 3);
  // Lock (~8 callbacks), then media time advances with the device.
  // Compared against the wall time between the two readings, not the sleep
  // asked for: a loaded machine oversleeps.
  std::optional<double> a;
  std::chrono::steady_clock::time_point ta;
  for (int i = 0; i < 400 && !a; ++i) {
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
    ta = std::chrono::steady_clock::now();
    a = clock.media_elapsed(ta);
  }
  REQUIRE(a.has_value());
  std::this_thread::sleep_for(std::chrono::milliseconds(300));
  const auto tb = std::chrono::steady_clock::now();
  const auto b = clock.media_elapsed(tb);
  REQUIRE(b.has_value());
  CHECK(*b - *a == Catch::Approx(std::chrono::duration<double>(tb - ta).count()).margin(0.08));
  const auto t = clock.comp_time(std::chrono::steady_clock::now());
  REQUIRE(t.has_value());
  CHECK(*t > 0.5);
  clock.pause();
  sys.stop_device();
}
