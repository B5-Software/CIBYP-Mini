/* SPDX-License-Identifier: GPL-3.0-or-later */
#define _POSIX_C_SOURCE 200809L
#include <linux/gpio.h>
#include <sys/ioctl.h>
#include <unistd.h>
#include <fcntl.h>
#include <poll.h>
#include <time.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <errno.h>
#include <signal.h>
static volatile sig_atomic_t stopping;
static void stop(int signal) {(void)signal; stopping = 1;}
static int64_t now_ms(void) {struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return (int64_t)t.tv_sec * 1000 + t.tv_nsec / 1000000;}
static int set(int fd, unsigned index, int value) {struct gpio_v2_line_values v = {.mask = UINT64_C(1) << index, .bits = value ? UINT64_C(1) << index : 0}; return ioctl(fd, GPIO_V2_LINE_SET_VALUES_IOCTL, &v);}
int main(int argc, char **argv) {
  signal(SIGTERM, stop); signal(SIGINT, stop);
  if (argc < 3 || argc > 66 || strncmp(argv[1], "/dev/gpiochip", 13)) return 2;
  for (const char *p = argv[1] + 13; *p; ++p) if (*p < '0' || *p > '9') return 2;
  struct gpio_v2_line_request request = {0}; request.num_lines = (unsigned)argc - 2; request.config.flags = GPIO_V2_LINE_FLAG_OUTPUT;
  uint64_t input_mask = 0, output_mask = 0;
  snprintf(request.consumer, sizeof request.consumer, "cibyp-mini");
  for (unsigned i = 0; i < request.num_lines; ++i) {
    const char *argument = argv[i + 2]; int input = !strncmp(argument, "in:", 3); if (input) argument += 3; else if (!strncmp(argument, "out:", 4)) argument += 4;
    char *end; errno = 0; unsigned long line = strtoul(argument, &end, 10); if (errno || end == argument || *end || line > 65535) return 2;
    request.offsets[i] = (unsigned)line; for (unsigned j = 0; j < i; ++j) if (request.offsets[j] == line) return 2;
    if (input) input_mask |= UINT64_C(1) << i; else output_mask |= UINT64_C(1) << i;
  }
  if (input_mask) {unsigned a = request.config.num_attrs++; request.config.attrs[a].attr.id = GPIO_V2_LINE_ATTR_ID_FLAGS; request.config.attrs[a].attr.flags = GPIO_V2_LINE_FLAG_INPUT; request.config.attrs[a].mask = input_mask;}
  if (output_mask) {unsigned a = request.config.num_attrs++; request.config.attrs[a].attr.id = GPIO_V2_LINE_ATTR_ID_OUTPUT_VALUES; request.config.attrs[a].attr.values = 0; request.config.attrs[a].mask = output_mask;}
  int chip = open(argv[1], O_RDONLY | O_CLOEXEC); if (chip < 0) {perror("gpiochip"); return 1;}
  if (ioctl(chip, GPIO_V2_GET_LINE_IOCTL, &request)) {perror("request lines"); close(chip); return 1;} close(chip);
  int64_t deadlines[64] = {0}; char input[160]; size_t length = 0; puts("READY"); fflush(stdout);
  while (!stopping) {
    int timeout = 1000; int64_t current = now_ms();
    for (unsigned i = 0; i < request.num_lines; ++i) if (deadlines[i]) {if (deadlines[i] <= current) {if (set(request.fd, i, 0)) goto done; deadlines[i] = 0;} else if (deadlines[i] - current < timeout) timeout = (int)(deadlines[i] - current);}
    struct pollfd p = {.fd = STDIN_FILENO, .events = POLLIN}; int n = poll(&p, 1, timeout); if (n < 0) {if (errno == EINTR) continue; break;} if (!n) continue;
    char ch; if (read(STDIN_FILENO, &ch, 1) != 1) break;
    if (ch != '\n') {if (length + 1 >= sizeof input) break; input[length++] = ch; continue;} input[length] = 0; length = 0;
    char op[8], extra; unsigned line; int value = 0, hold = 0;
    int fields = sscanf(input, "%7s %u %d %d %c", op, &line, &value, &hold, &extra); unsigned index;
    if (fields < 2) {puts("ERR"); fflush(stdout); continue;}
    for (index = 0; index < request.num_lines && request.offsets[index] != line; ++index) {}
    if (fields < 2 || index == request.num_lines) {puts("ERR"); fflush(stdout); continue;}
    if (!strcmp(op, "GET") && fields == 2) {struct gpio_v2_line_values v = {.mask = UINT64_C(1) << index}; if (ioctl(request.fd, GPIO_V2_LINE_GET_VALUES_IOCTL, &v)) puts("ERR"); else printf("OK %d\n", !!(v.bits & v.mask));}
    else if (!strcmp(op, "SET") && (output_mask & (UINT64_C(1) << index)) && fields == 4 && (value == 0 || value == 1) && hold > 0 && hold <= 60000) {if (set(request.fd, index, value)) puts("ERR"); else {deadlines[index] = value ? now_ms() + hold : 0; printf("OK %d\n", value);}}
    else {puts("ERR");}
    fflush(stdout);
  }
done:
  for (unsigned i = 0; i < request.num_lines; ++i) if (output_mask & (UINT64_C(1) << i)) (void)set(request.fd, i, 0);
  close(request.fd); return 0;
}
