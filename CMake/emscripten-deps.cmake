# 2S2H [WASM] Dependency provisioning for the Emscripten target.
#
# LUS and 2ship call find_package(REQUIRED) for libzip, nlohmann_json, tinyxml2, spdlog and
# the audio codecs. None of those resolve when cross-compiling to wasm: the host's
# Homebrew/apt copies are native binaries, and Emscripten ships ports for only some of
# them. Rather than patch every find_package call site, each dependency is declared with
# OVERRIDE_FIND_PACKAGE (CMake >= 3.24), which redirects find_package to a source build.
#
# Emscripten *does* ship ports for SDL2, ogg, vorbis, zlib and libpng; those are requested
# with --use-port on the compile/link line instead (see the EMSCRIPTEN branch in the root
# CMakeLists), and find_package is pointed at the port where a dependency asks for one.
# Opus and OpusFile have no port and no source build here yet -- see wasm-port.md.

include(FetchContent)

set(FETCHCONTENT_QUIET OFF)

# --- zlib -------------------------------------------------------------------
# From the port, not from source. --use-port=libpng pulls in the zlib port whatever this file
# does, so a second zlib built here meant two zlib.h on the include path and two libz.a at
# link, of different versions, resolved by link order.
#
# libzip and StormLib still call find_package(ZLIB) and link ZLIB::ZLIB. A config file in
# the redirects directory answers that before any Find module is tried; the target it
# defines is empty because the port flags, applied globally, already supply the headers and
# the library. The version file accepts any requested version: the port's is Emscripten's to
# choose, and libzip only asks for 1.1.2 or later.
file(WRITE "${CMAKE_FIND_PACKAGE_REDIRECTS_DIR}/zlib-config.cmake"
"if(NOT TARGET ZLIB::ZLIB)
    add_library(ZLIB::ZLIB INTERFACE IMPORTED GLOBAL)
endif()
set(ZLIB_FOUND TRUE)
set(ZLIB_INCLUDE_DIRS \"\")
set(ZLIB_LIBRARY ZLIB::ZLIB)
set(ZLIB_LIBRARIES ZLIB::ZLIB)
")
file(WRITE "${CMAKE_FIND_PACKAGE_REDIRECTS_DIR}/zlib-config-version.cmake"
"set(PACKAGE_VERSION_COMPATIBLE TRUE)
")

# --- libzip -----------------------------------------------------------------
# .o2r archives are zip containers, so this one is load-bearing. Everything optional is
# switched off: the compression backends beyond zlib, the CLI tools, tests and docs.
set(ENABLE_BZIP2 OFF CACHE BOOL "" FORCE)
set(ENABLE_LZMA OFF CACHE BOOL "" FORCE)
set(ENABLE_ZSTD OFF CACHE BOOL "" FORCE)
set(ENABLE_COMMONCRYPTO OFF CACHE BOOL "" FORCE)
set(ENABLE_GNUTLS OFF CACHE BOOL "" FORCE)
set(ENABLE_MBEDTLS OFF CACHE BOOL "" FORCE)
set(ENABLE_OPENSSL OFF CACHE BOOL "" FORCE)
set(ENABLE_WINDOWS_CRYPTO OFF CACHE BOOL "" FORCE)
set(BUILD_TOOLS OFF CACHE BOOL "" FORCE)
set(BUILD_REGRESS OFF CACHE BOOL "" FORCE)
set(BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(BUILD_DOC OFF CACHE BOOL "" FORCE)
set(BUILD_OSSFUZZ OFF CACHE BOOL "" FORCE)
set(LIBZIP_DO_INSTALL OFF CACHE BOOL "" FORCE)
FetchContent_Declare(
    libzip
    GIT_REPOSITORY https://github.com/nih-at/libzip.git
    GIT_TAG v1.10.1
    OVERRIDE_FIND_PACKAGE
)

# --- nlohmann_json ----------------------------------------------------------
set(JSON_BuildTests OFF CACHE INTERNAL "")
FetchContent_Declare(
    nlohmann_json
    GIT_REPOSITORY https://github.com/nlohmann/json.git
    GIT_TAG v3.11.3
    OVERRIDE_FIND_PACKAGE
)

# --- tinyxml2 ---------------------------------------------------------------
set(tinyxml2_BUILD_TESTING OFF CACHE BOOL "" FORCE)
FetchContent_Declare(
    tinyxml2
    GIT_REPOSITORY https://github.com/leethomason/tinyxml2.git
    GIT_TAG 10.0.0
    OVERRIDE_FIND_PACKAGE
)

# --- spdlog -----------------------------------------------------------------
set(SPDLOG_BUILD_EXAMPLE OFF CACHE BOOL "" FORCE)
set(SPDLOG_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(SPDLOG_INSTALL OFF CACHE BOOL "" FORCE)
FetchContent_Declare(
    spdlog
    GIT_REPOSITORY https://github.com/gabime/spdlog.git
    GIT_TAG v1.14.1
    OVERRIDE_FIND_PACKAGE
)
